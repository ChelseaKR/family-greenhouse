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
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const JOBS = Number(option('--jobs') ?? process.env.GATE_JOBS ?? availableParallelism());

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

/** Never rejects: a spawn failure is a failed step, not a crashed runner. */
function runStep(step) {
  return new Promise((settle) => {
    const started = Date.now();
    const args = commandFor(step);
    let child;
    try {
      child = spawn('npm', args, {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: tty ? '1' : '0' },
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

async function main() {
  const steps = await loadPlan();

  if (!Number.isFinite(JOBS) || JOBS < 1) {
    throw new Error(`--jobs/GATE_JOBS must be a positive number, got "${JOBS}".`);
  }
  const limit = Math.floor(JOBS);

  const scheduled = steps.filter((s) => s.weight > 0).length;
  console.log(
    c.bold(`gate: ${steps.length} steps`) +
      c.dim(
        ` · ${scheduled} scheduled across ${limit} job slots, ${steps.length - scheduled} unscheduled · --jobs N to change\n`
      )
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
        entry.promise = runStep(step).then((r) => {
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
      await Promise.race(active.map((e) => e.promise));
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
