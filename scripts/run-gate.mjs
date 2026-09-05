#!/usr/bin/env node
/**
 * Runs the local quality gate (`npm run verify`, and so `.githooks/pre-push`)
 * with its independent steps in parallel.
 *
 * Why: `verify` was a serial `&&` chain of fifteen commands. Measured on a
 * 10-core laptop it took roughly six minutes, nearly all of it one core busy
 * and nine idle. Nothing in the chain depended on anything earlier in it —
 * every step is a read-only check over files already on disk, and the only
 * writes are each workspace's own `coverage/` directory, which no other step
 * reads. See scripts/gate-steps.mjs for the step list and the weights.
 *
 * The thing this runner must not become is a gate that reports green because
 * it lost track of a step. That failure mode — a check that cannot fail — is
 * the defect this repo keeps finding in its own tooling (see
 * scripts/check-no-silenced-gates.mjs, and the `main()`-always-returns-0 gate
 * this repo's standards call out). So the runner is deliberately paranoid:
 *
 *   - Every step's exit code is checked. Non-zero fails the gate. A step
 *     killed by a signal (exit code null) fails the gate. A step that could
 *     not be spawned at all fails the gate.
 *   - After the pool drains, the number of results must equal the number of
 *     planned steps, or the gate fails with a runner-bug message rather than
 *     passing. A dropped step is indistinguishable from a passing one at the
 *     end, so it is checked explicitly.
 *   - The plan must be a non-empty array, and every entry must name a script
 *     that actually exists in the package.json it will run in.
 *   - The workspaces the plan covers must equal package.json's `workspaces`,
 *     so adding a third workspace fails the gate loudly instead of having it
 *     silently go unchecked (the old chain's `--workspaces --if-present`
 *     covered new workspaces automatically; an explicit list needs this).
 *   - Top-level rejections and uncaught exceptions exit non-zero.
 *
 * Before any of that, a preflight compares `node_modules` against
 * `package-lock.json` (scripts/check-dependency-freshness.mjs). Every step
 * below reads as a statement about the SOURCE tree when it fails, and that
 * reading is wrong if the installed tree is stale — see `preflight()` and #581.
 * It is the one thing the gate stops on, because continuing produces up to
 * twenty-eight failures that all describe the same missing package and none of
 * which says so.
 *
 * The runner also sizes itself for the machine it is ACTUALLY on rather than
 * the machine it would have alone. `availableParallelism()` reports cores, not
 * free cores, so three concurrent `npm run verify` runs used to size three
 * pools as if each were the only one — three times the demand against one
 * machine's supply, and jsdom tests missing deadlines at random in whichever
 * run was scheduled worst (#596). scripts/gate-census.mjs counts the gate runs
 * on the machine; the pool width is the ceiling divided by that count, re-asked
 * on every scheduling pass so a gate that started alone narrows when company
 * arrives. A gate that IS alone divides by one and is unchanged.
 *
 * Output: each step's stdout/stderr is buffered and only printed if that step
 * fails, so fifteen concurrent commands do not interleave into noise. Every
 * step gets a one-line PASS/FAIL as it finishes, and failures are reprinted in
 * full at the end, each under a banner naming the step, what it catches, and
 * the exact command to reproduce it on its own. `--verbose` prints the output
 * of passing steps too.
 *
 * The gate does NOT stop at the first failure. A six-minute gate wants to fail
 * fast; a ninety-second one is better spent telling you everything that is
 * wrong in one pass, so you fix it once instead of discovering the next
 * failure on the next push.
 *
 * Usage:
 *   node scripts/run-gate.mjs [--jobs N] [--verbose] [--plan <path>]
 *   GATE_JOBS=4 node scripts/run-gate.mjs
 *   GATE_PEERS=1 node scripts/run-gate.mjs   # ignore the other gates; take
 *                                            # the whole machine (pre-#596)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkDependencyFreshness, formatFreshnessFailure } from './check-dependency-freshness.mjs';
import { jobBudget, peers as countPeers } from './gate-census.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- argv ------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function option(name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
}

const VERBOSE = flag('--verbose');
const PLAN_PATH = option('--plan');
// `availableParallelism()` respects cgroup/affinity limits, unlike cpus().
// This is a CEILING, not the width: the census divides it by the number of
// gate runs sharing the machine (scripts/gate-census.mjs, #596). Alone, the
// division is by one and this is exactly what the pool ends up being.
const JOBS = Number(option('--jobs') ?? process.env.GATE_JOBS ?? availableParallelism());
const CORES = availableParallelism();
/**
 * How often to re-count the gates on the machine while steps are running.
 * The loop re-counts whenever a step finishes anyway; this covers the case
 * the census would otherwise miss — a gate that was alone when it started and
 * has company by the time it reaches the suites. `ps` costs tens of
 * milliseconds, so ten seconds of staleness is the tradeoff, not a limit.
 */
const RECENSUS_MS = 10_000;

// --- colour (only when a human is watching) --------------------------------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
};

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// --- plan loading and validation -------------------------------------------

function pkgAt(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * Reads the plan and refuses anything that could make the gate check less
 * than it claims to. Throws — main() turns that into a non-zero exit.
 */
async function loadPlan() {
  const modulePath = PLAN_PATH ? resolve(PLAN_PATH) : join(ROOT, 'scripts', 'gate-steps.mjs');
  const mod = await import(pathToFileURL(modulePath).href);
  const steps = mod.STEPS;
  const workspaces = mod.WORKSPACES;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(
      `${modulePath}: STEPS must be a non-empty array — a gate with no steps passes everything.`
    );
  }

  const seen = new Set();
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || !step.id) {
      throw new Error(`${modulePath}: every step needs a non-empty string \`id\`.`);
    }
    if (seen.has(step.id)) {
      throw new Error(`${modulePath}: duplicate step id \`${step.id}\`.`);
    }
    seen.add(step.id);
    if (typeof step.script !== 'string' || !step.script) {
      throw new Error(`${modulePath}: step \`${step.id}\` needs a \`script\` to run.`);
    }
    if (!Number.isFinite(step.weight) || step.weight < 0) {
      throw new Error(
        `${modulePath}: step \`${step.id}\` needs a non-negative numeric \`weight\`.`
      );
    }
    // A step naming a script that does not exist would exit non-zero anyway,
    // but as a confusing npm error at run time. Catch it up front, and catch
    // the more dangerous direction too: a script silently renamed away.
    const dir = step.workspace ? join(ROOT, step.workspace) : ROOT;
    const scripts = pkgAt(dir).scripts ?? {};
    if (!(step.script in scripts)) {
      throw new Error(
        `${modulePath}: step \`${step.id}\` runs \`${step.script}\`, which ${
          step.workspace ? `${step.workspace}/package.json` : 'package.json'
        } does not define. Rename it in both places or drop the step.`
      );
    }
  }

  // The old chain used `--workspaces`, which picked up new workspaces for
  // free. This list is explicit, so drift has to be made loud.
  if (!Array.isArray(workspaces)) {
    throw new Error(`${modulePath}: WORKSPACES must be an array.`);
  }
  const declared = pkgAt(ROOT).workspaces ?? [];
  const sorted = (a) => [...a].sort().join(',');
  if (sorted(workspaces) !== sorted(declared)) {
    throw new Error(
      `${modulePath}: WORKSPACES is [${workspaces.join(', ')}] but package.json declares [${declared.join(
        ', '
      )}]. Every workspace needs its own lint/typecheck/test steps in the gate — add them, then update WORKSPACES.`
    );
  }
  const covered = new Set(steps.filter((s) => s.workspace).map((s) => s.workspace));
  for (const ws of workspaces) {
    if (!covered.has(ws)) {
      throw new Error(
        `${modulePath}: workspace \`${ws}\` has no gate steps — it would go unchecked.`
      );
    }
  }

  return steps;
}

// --- running one step ------------------------------------------------------

function commandFor(step) {
  const args = ['run', step.script];
  if (step.workspace) args.push('--workspace', step.workspace);
  return args;
}

/**
 * Never rejects: a spawn failure is a failed step, not a crashed runner.
 *
 * `sharing` is the current gate count, passed down as `GATE_PEERS` so a step
 * that runs its own worker pool can divide it the same way (see
 * `frontend/vitest.config.ts`). Without it a step would size four vitest
 * workers per gate on a ten-core machine three gates are sharing, which is the
 * oversubscription #596 is about — narrowing the gate's own pool alone would
 * not touch it.
 */
function runStep(step, sharing) {
  return new Promise((settle) => {
    const started = Date.now();
    const args = commandFor(step);
    let child;
    try {
      child = spawn('npm', args, {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: tty ? '1' : '0',
          GATE_PEERS: String(sharing),
        },
      });
    } catch (err) {
      settle({ step, ok: false, ms: Date.now() - started, output: String(err?.stack ?? err) });
      return;
    }

    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      settle(result);
    };

    child.on('error', (err) => {
      finish({
        step,
        ok: false,
        ms: Date.now() - started,
        output: `${Buffer.concat(chunks).toString('utf8')}\nfailed to run \`npm ${args.join(' ')}\`: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      // `code` is null when the child died from a signal. Treating that as
      // anything but a failure is how a gate stops being a gate.
      const ok = code === 0 && signal === null;
      finish({
        step,
        ok,
        code,
        signal,
        ms: Date.now() - started,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

// --- the pool --------------------------------------------------------------

/**
 * Runs before anything is scheduled. Returns true to continue.
 *
 * Every step below is a check of the source tree, and every one of them reads
 * as a statement ABOUT the source tree when it fails. That reading is wrong if
 * `node_modules` is not the tree `package-lock.json` describes: then lint,
 * typecheck and both suites fail on module resolution, and the gate's report
 * points at whichever of them happened to notice first. On 2026-09-05 that cost
 * a blocked release — `gate FAILED — 1 of 28 steps failed in 83.3s: test:backend`
 * for fifteen suites that could not import a devDependency added 139 commits
 * earlier and never installed (#581).
 *
 * So this runs first and, on failure, stops. Not as a step: a step would run
 * concurrently with the twenty-eight failures it explains, and the reader would
 * still have to find it among them. It costs ~0.2s against the gate's ~90s.
 */
async function preflight() {
  const started = Date.now();
  let report;
  try {
    report = await checkDependencyFreshness(ROOT);
  } catch (err) {
    // The comparison could not be made. A check that cannot check must not be
    // reported as one that passed.
    console.error(
      c.red(`\ngate BLOCKED — the dependency freshness check could not run: ${err.message}`)
    );
    return false;
  }

  if (!report.ok) {
    console.error(`${c.red('─'.repeat(72))}`);
    console.error(c.red(c.bold('gate BLOCKED — dependencies, not code')));
    console.error(c.red('─'.repeat(72)));
    console.error(formatFreshnessFailure(report));
    console.error(
      c.dim(
        'No gate step ran. Whatever they reported from this tree would have described\n' +
          'the installed dependencies, not your change.'
      )
    );
    return false;
  }

  console.log(
    c.dim(
      `preflight  ${secs(Date.now() - started).padStart(6)}  node_modules matches package-lock.json (${report.checked} packages)`
    )
  );
  return true;
}

/**
 * A timer that can be raced against the running steps and then cancelled, so
 * the scheduling loop wakes up to re-count the gates on the machine even while
 * every step it started is still running.
 */
function tick(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The failure signatures that mean "this did not get a CPU slice in time",
 * as opposed to "this is wrong". All four are shapes #596 measured on a
 * ten-core laptop carrying three concurrent gates.
 *
 * The last two do not respond to any vitest setting at all: in vitest 4.1.11
 * the pool runner's start and stop deadlines are module-level constants
 * (`START_TIMEOUT`/`STOP_TIMEOUT`, 60s, passed straight to `withTimeout`), so
 * `testTimeout` cannot reach them. A worker that takes longer than a minute to
 * START kills the run and takes unrelated files down with it. Nothing but
 * reducing contention can prevent that, which is why the census exists.
 */
const STARVATION_SIGNATURES = [
  /Test timed out in \d+\s*ms/,
  /Hook timed out in \d+\s*ms/,
  /Timeout waiting for worker to respond/,
  /Timeout starting .*runner/,
];

/**
 * A note to print after a failure whose every failing step is a timeout, on a
 * machine whose load average is above its core count.
 *
 * This does NOT change the result. The gate still failed and the push is still
 * refused — a starving gate and a broken change are not distinguishable from
 * here, and guessing would be the "gate that cannot fail" defect this runner
 * is otherwise careful about. What it changes is what the reader is told: the
 * difference between a gate that looks like it is lying about your change and
 * a gate that says it was busy and how to check.
 *
 * Returns null unless BOTH conditions hold, so a real regression on a quiet
 * machine never sees it.
 */
function starvationNote(failed) {
  if (failed.length === 0) return null;
  const load = loadavg()[0];
  if (!(load > CORES)) return null;
  if (!failed.every((r) => STARVATION_SIGNATURES.some((re) => re.test(r.output)))) return null;

  let gates = 1;
  try {
    gates = countPeers().peers;
  } catch {
    // The count is decoration here; its absence must not swallow the report.
  }

  const lines = [
    '',
    `Every failure above is a timeout, and this machine is at load average ${load.toFixed(
      1
    )} on ${plural(CORES, 'core')}${gates > 1 ? `, with ${plural(gates, 'gate run')} on it` : ''}.`,
    'That is the shape of a starved gate (#596): under that much contention a jsdom',
    'render-and-query test waits for a CPU slice, not for the code under test, and a',
    'vitest worker can miss a 60s START deadline that no setting reaches.',
    '',
    'This is still a failure and the push is still refused. But before you look for',
    'the bug in your change, run the named file on its own — if it passes alone, the',
    'gate was busy rather than wrong:',
    '',
    '    cd frontend && ./node_modules/.bin/vitest run <the file the failure names>',
    '',
    '`node scripts/gate-census.mjs` shows what else is running.',
  ];
  return lines.join('\n');
}

async function main() {
  const steps = await loadPlan();

  if (!Number.isFinite(JOBS) || JOBS < 1) {
    throw new Error(`--jobs/GATE_JOBS must be a positive number, got "${JOBS}".`);
  }
  const ceiling = Math.floor(JOBS);

  if (!(await preflight())) return 1;

  // Divide the machine by the gates on it, and keep dividing: a gate that
  // starts alone and acquires company mid-run narrows on the next pass (#596).
  const census = () => {
    const { peers: gates, source } = countPeers();
    return { gates, source, slots: jobBudget({ cores: CORES, peers: gates, ceiling }) };
  };
  let { gates: sharing, slots: limit, source } = census();

  const scheduled = steps.filter((s) => s.weight > 0).length;
  console.log(
    c.bold(`gate: ${steps.length} steps`) +
      c.dim(
        ` · ${scheduled} scheduled across ${plural(limit, 'job slot')}, ${steps.length - scheduled} unscheduled · --jobs N to change\n`
      ) +
      (sharing > 1
        ? c.dim(
            `sharing ${plural(CORES, 'core')} with ${plural(sharing - 1, 'other gate run')}` +
              `${source === 'env' ? ' (GATE_PEERS)' : ''}` +
              `${limit < ceiling ? `, narrowed from ${ceiling}` : ''} (#596)\n`
          )
        : '')
  );

  const started = Date.now();
  const pending = [...steps];
  const active = [];
  const results = [];
  let used = 0;

  const report = (r) => {
    const label = r.ok ? c.green(' PASS ') : c.red(' FAIL ');
    const detail = r.ok
      ? ''
      : c.red(r.signal ? ` (killed by ${r.signal})` : ` (exit ${r.code ?? '?'})`);
    console.log(`${label} ${secs(r.ms).padStart(6)}  ${r.step.id}${detail}`);
    if (VERBOSE && r.ok && r.output.trim()) {
      console.log(r.output.replace(/^/gm, '        '));
    }
  };

  while (pending.length > 0 || active.length > 0) {
    const now = census();
    if (now.slots !== limit) {
      console.log(
        c.dim(
          `census: ${plural(now.gates, 'gate run')} on ${plural(CORES, 'core')} — ${
            now.slots > limit ? 'widening' : 'narrowing'
          } to ${plural(now.slots, 'job slot')}`
        )
      );
    }
    limit = now.slots;
    sharing = now.gates;

    for (let i = 0; i < pending.length;) {
      const step = pending[i];
      // Clamp so a step heavier than the whole pool still runs (alone).
      const need = Math.min(step.weight, limit);
      const fits = used + need <= limit;
      // `active.length === 0` keeps a too-heavy step from deadlocking the pool.
      if (need === 0 || fits || active.length === 0) {
        pending.splice(i, 1);
        used += need;
        const entry = { done: false };
        entry.promise = runStep(step, sharing).then((r) => {
          used -= need;
          entry.done = true;
          results.push(r);
          report(r);
          return r;
        });
        active.push(entry);
        continue;
      }
      i += 1;
    }
    if (active.length > 0) {
      // Wake for whichever comes first: a step finishing, or the next census.
      // Without the timer a gate that started alone would keep its wide pool
      // for as long as its longest step runs, which is exactly the window the
      // frontend suite occupies.
      const wake = tick(RECENSUS_MS);
      await Promise.race([...active.map((e) => e.promise), wake.promise]);
      wake.cancel();
      for (let i = active.length - 1; i >= 0; i -= 1) {
        if (active[i].done) active.splice(i, 1);
      }
    }
  }

  const elapsed = Date.now() - started;

  // A step that never produced a result is a step that never ran, and at this
  // point it looks exactly like one that passed. Say so instead of exiting 0.
  if (results.length !== steps.length) {
    const missing = steps.filter((s) => !results.some((r) => r.step.id === s.id)).map((s) => s.id);
    console.error(
      c.red(
        `\ngate runner bug: planned ${steps.length} steps but collected ${results.length} results (missing: ${missing.join(', ')}). Refusing to report a pass.`
      )
    );
    return 1;
  }

  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    console.log(c.green(`\ngate PASSED`) + c.dim(` — ${steps.length} steps in ${secs(elapsed)}`));
    return 0;
  }

  for (const r of failed) {
    const args = commandFor(r.step);
    console.error(`\n${c.red('─'.repeat(72))}`);
    console.error(c.red(c.bold(`FAILED: ${r.step.id}`)) + c.dim(` — checks ${r.step.why}`));
    console.error(c.dim(`reproduce: npm ${args.join(' ')}`));
    console.error(c.red('─'.repeat(72)));
    console.error(r.output.trimEnd() || c.dim('(no output)'));
  }

  console.error(
    `\n${c.red(c.bold('gate FAILED'))} — ${failed.length} of ${steps.length} steps failed in ${secs(
      elapsed
    )}: ${failed.map((r) => r.step.id).join(', ')}`
  );

  const note = starvationNote(failed);
  if (note) console.error(c.dim(note));

  return 1;
}

// A rejection that escapes here must never leave the exit code at 0.
process.on('unhandledRejection', (err) => {
  console.error(c.red(`gate runner: unhandled rejection — ${err?.stack ?? err}`));
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(c.red(`gate runner: uncaught exception — ${err?.stack ?? err}`));
  process.exit(1);
});

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(c.red(`\ngate runner failed to start: ${err?.message ?? err}`));
    process.exitCode = 1;
  }
);
