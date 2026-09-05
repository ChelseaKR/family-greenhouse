/**
 * The local gate's parallel runner (`scripts/run-gate.mjs`) is the thing that
 * decides whether `git push` is allowed to proceed. If it ever loses a step,
 * mistakes a signal death for a pass, or swallows a child's exit code, the
 * whole gate becomes a green tick that means nothing — the "gate that cannot
 * fail" defect this repo already has a checker for
 * (scripts/check-no-silenced-gates.mjs).
 *
 * So these tests drive the real runner as a child process against a throwaway
 * fixture repo: a temp directory with its own package.json, its own workspace,
 * a copy of run-gate.mjs, and a plan whose steps are trivial node one-liners
 * that pass, fail, or die however the test needs. Nothing here stubs the
 * runner's internals; the assertions are on its exit code and its output.
 *
 * It lives under backend/ because the repo's root has no test runner of its
 * own and backend's vitest is the nearest one — the same reason
 * tests/integration/route-terraform-parity.test.ts reaches up into
 * infrastructure/. The runner itself is loaded only as a child process, never
 * imported, so it stays out of this workspace's coverage accounting.
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// These cases are not unit tests in the usual cost sense: each one runs the
// real runner, which spawns two or three real `npm run` processes. npm's own
// startup is ~0.4s on an idle machine and several seconds on a busy one, and
// the `--jobs 1` case pays it serially.
//
// The suite's 10s default is therefore too tight for this file specifically.
// It has already failed a push on a laptop at load average 97 — "Test timed
// out in 10000ms" on the `--jobs 1` case — which is the worst kind of gate
// failure: unrelated to the change being pushed, and indistinguishable at a
// glance from a real one.
//
// A minute is not a weaker assertion, only a more patient one. Nothing here
// asserts a duration; every case still asserts an exit code and the runner's
// output, so a runner that genuinely hung would still fail, just later.
vi.setConfig({ testTimeout: 60_000 });

const REAL_RUNNER = resolve(__dirname, '../../../../scripts/run-gate.mjs');
const REAL_FRESHNESS = resolve(__dirname, '../../../../scripts/check-dependency-freshness.mjs');
const REAL_CENSUS = resolve(__dirname, '../../../../scripts/gate-census.mjs');

/**
 * A package the fixture's lockfile requires, and (unless a test says
 * otherwise) installs into the fixture's node_modules.
 */
interface FixturePackage {
  /** Where the lockfile places it, e.g. `node_modules/left-pad`. */
  path: string;
  /** The version the lockfile pins. */
  version: string;
  /** The version actually written to disk; omit to leave it uninstalled. */
  installedVersion?: string;
}

interface Step {
  id: string;
  script: string;
  workspace?: string;
  weight: number;
  why: string;
}

interface RunResult {
  code: number;
  out: string;
}

/**
 * Builds a fixture repo and runs the real runner in it.
 *
 * `scripts` are the root package.json scripts the plan may name; `wsScripts`
 * are the fixture workspace's. `workspacesInPlan` defaults to matching the
 * fixture's declared workspaces — tests override it to prove the mismatch is
 * caught.
 */
function runGate(opts: {
  steps: Step[];
  scripts?: Record<string, string>;
  wsScripts?: Record<string, string>;
  workspacesInPlan?: string[];
  args?: string[];
  /** Dependencies of the fixture ROOT, as the lockfile and disk see them. */
  packages?: FixturePackage[];
  /** Drop `node_modules/.package-lock.json`, i.e. "never installed". */
  uninstalled?: boolean;
  /** Remove `package-lock.json` entirely. */
  noLockfile?: boolean;
  /** Add a platform-specific optional package that is (correctly) absent. */
  optionalAbsent?: boolean;
  /** Extra environment for the runner; overrides the defaults below. */
  env?: Record<string, string>;
}): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'gate-runner-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'ws'), { recursive: true });
  copyFileSync(REAL_RUNNER, join(root, 'scripts', 'run-gate.mjs'));
  copyFileSync(REAL_FRESHNESS, join(root, 'scripts', 'check-dependency-freshness.mjs'));
  copyFileSync(REAL_CENSUS, join(root, 'scripts', 'gate-census.mjs'));

  const packages = opts.packages ?? [];
  const nameOf = (path: string) => path.slice(path.lastIndexOf('node_modules/') + 13);
  // An optional dependency for a platform this process is definitely not on.
  const OPTIONAL = '@fixture/binary-for-another-platform';
  const optionalDependencies = opts.optionalAbsent ? { [OPTIONAL]: '^1.0.0' } : undefined;

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'gate-fixture',
      private: true,
      workspaces: ['ws'],
      dependencies: Object.fromEntries(packages.map((p) => [nameOf(p.path), `^${p.version}`])),
      ...(optionalDependencies ? { optionalDependencies } : {}),
      scripts: opts.scripts ?? {},
    })
  );
  writeFileSync(
    join(root, 'ws', 'package.json'),
    JSON.stringify({ name: 'ws', version: '0.0.0', scripts: opts.wsScripts ?? {} })
  );

  // The runner's preflight compares node_modules against package-lock.json
  // before it schedules anything (#581), so the fixture is a repo that has
  // actually been installed unless a test asks for otherwise.
  if (!opts.noLockfile) {
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'gate-fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'gate-fixture', workspaces: ['ws'] },
          ws: { name: 'ws', version: '0.0.0' },
          'node_modules/ws': { resolved: 'ws', link: true },
          ...Object.fromEntries(packages.map((p) => [p.path, { version: p.version }])),
          ...(optionalDependencies
            ? {
                [`node_modules/${OPTIONAL}`]: {
                  version: '1.0.0',
                  optional: true,
                  os: ['aix'],
                  cpu: ['ppc64'],
                },
              }
            : {}),
        },
      })
    );
  }
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  if (!opts.uninstalled) {
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"packages":{}}');
  }
  for (const p of packages) {
    if (p.installedVersion === undefined) continue;
    mkdirSync(join(root, p.path), { recursive: true });
    writeFileSync(
      join(root, p.path, 'package.json'),
      JSON.stringify({ name: nameOf(p.path), version: p.installedVersion })
    );
  }
  writeFileSync(
    join(root, 'scripts', 'gate-steps.mjs'),
    `export const WORKSPACES = ${JSON.stringify(opts.workspacesInPlan ?? ['ws'])};\n` +
      `export const STEPS = ${JSON.stringify(opts.steps)};\n`
  );

  const argv = [join(root, 'scripts', 'run-gate.mjs'), ...(opts.args ?? [])];
  try {
    const stdout = execFileSync(process.execPath, argv, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // `GATE_PEERS: '1'` pins the fixture to the single-gate case (#596).
      // Without it the runner counts the gates on the REAL machine, so a
      // laptop with three `npm run verify` runs on it would narrow this
      // fixture's pool and every assertion about scheduling below would
      // depend on what else the developer happened to be doing. The census
      // itself is tested separately, against a machine it is allowed to see.
      env: { ...process.env, NO_COLOR: '1', GATE_PEERS: '1', ...(opts.env ?? {}) },
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const step = (id: string, script: string, extra: Partial<Step> = {}): Step => ({
  id,
  script,
  weight: 0,
  why: `the ${id} contract`,
  ...extra,
});

/** A step in the fixture workspace, so every declared workspace is covered. */
const wsStep = (id: string, script: string, extra: Partial<Step> = {}): Step =>
  step(id, script, { workspace: 'ws', ...extra });

const PASSES = 'node -e "console.log(\'all good\')"';
const FAILS = 'node -e "console.error(\'the thing is wrong\'); process.exit(3)"';

describe('run-gate: the happy path', () => {
  it('passes, and reports every planned step', () => {
    const { code, out } = runGate({
      scripts: { a: PASSES, b: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), step('beta', 'b'), wsStep('gamma', 'w')],
    });

    expect(code).toBe(0);
    expect(out).toContain('gate PASSED');
    for (const id of ['alpha', 'beta', 'gamma']) {
      expect(out).toMatch(new RegExp(`PASS\\s+[\\d.]+s\\s+${id}`));
    }
  });

  it('keeps a passing step’s output out of the way unless asked for it', () => {
    const quiet = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('gamma', 'w')],
    });
    expect(quiet.out).not.toContain('all good');

    const loud = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('gamma', 'w')],
      args: ['--verbose'],
    });
    expect(loud.out).toContain('all good');
  });
});

describe('run-gate: a failing step fails the gate', () => {
  it('exits non-zero, names the step, and reprints its output', () => {
    const { code, out } = runGate({
      scripts: { good: PASSES, bad: FAILS },
      wsScripts: { w: PASSES },
      steps: [step('ok-step', 'good'), step('broken-step', 'bad'), wsStep('ws-step', 'w')],
    });

    expect(code).toBe(1);
    expect(out).toContain('gate FAILED');
    // Names the step that failed, in the summary and in its own banner.
    expect(out).toContain('FAILED: broken-step');
    expect(out).toMatch(/1 of 3 steps failed in [\d.]+s: broken-step/);
    // The failing step's own output survives the buffering.
    expect(out).toContain('the thing is wrong');
    // And it says how to run just that step again.
    expect(out).toContain('reproduce: npm run bad');
    // The other steps still ran — a failure must not cancel the rest.
    expect(out).toMatch(/PASS\s+[\d.]+s\s+ok-step/);
    expect(out).toMatch(/PASS\s+[\d.]+s\s+ws-step/);
  });

  it('reports every failure, not just the first', () => {
    const { code, out } = runGate({
      scripts: { bad: FAILS, alsoBad: FAILS },
      wsScripts: { w: PASSES },
      steps: [step('first-bad', 'bad'), step('second-bad', 'alsoBad'), wsStep('ws-step', 'w')],
    });

    expect(code).toBe(1);
    expect(out).toContain('FAILED: first-bad');
    expect(out).toContain('FAILED: second-bad');
    expect(out).toMatch(/2 of 3 steps failed/);
  });

  it('fails on a step killed by a signal, which exits with a null code', () => {
    const { code, out } = runGate({
      scripts: { suicide: 'node -e "process.kill(process.pid, \'SIGKILL\')"' },
      wsScripts: { w: PASSES },
      steps: [step('killed-step', 'suicide'), wsStep('ws-step', 'w')],
    });

    expect(code).toBe(1);
    expect(out).toContain('FAILED: killed-step');
  });

  it('still fails a failing step when the pool is narrowed to one job', () => {
    const { code, out } = runGate({
      scripts: { good: PASSES, bad: FAILS },
      wsScripts: { w: PASSES },
      steps: [
        step('heavy-ok', 'good', { weight: 4 }),
        step('heavy-bad', 'bad', { weight: 4 }),
        wsStep('ws-step', 'w', { weight: 2 }),
      ],
      args: ['--jobs', '1'],
    });

    expect(code).toBe(1);
    expect(out).toContain('FAILED: heavy-bad');
    // A step weighing more than the whole pool must still run, not deadlock.
    expect(out).toMatch(/PASS\s+[\d.]+s\s+heavy-ok/);
    expect(out).toMatch(/PASS\s+[\d.]+s\s+ws-step/);
  });
});

/**
 * The preflight exists because `gate FAILED — 1 of 28 steps failed in 83.3s:
 * test:backend` was, on 2026-09-05, a true statement that sent its reader to
 * the wrong place: fifteen backend suites could not import a devDependency
 * added 139 commits earlier and never installed (#581).
 *
 * What these assert is not just "it fails" but "it fails INSTEAD" — no step
 * runs, so there is no 83 seconds of misleading output to read past.
 */
describe('run-gate: stale dependencies block the gate before any step runs', () => {
  const PKG = 'node_modules/express-rate-limit';

  it('blocks on a package the lockfile requires and node_modules lacks', () => {
    const { code, out } = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
      // Pinned by the lockfile, absent from disk — the #581 shape exactly.
      packages: [{ path: PKG, version: '8.7.0' }],
    });

    expect(code).toBe(1);
    expect(out).toContain('gate BLOCKED');
    expect(out).toContain('NOT INSTALLED');
    expect(out).toContain('express-rate-limit@8.7.0');
    // The remedy, unambiguously, and not a step name.
    expect(out).toContain('npm ci');
    // The point of the preflight: nothing else ran, so nothing else can be
    // mistaken for the cause.
    expect(out).not.toContain('gate PASSED');
    expect(out).not.toContain('gate FAILED');
    expect(out).not.toMatch(/PASS\s+[\d.]+s\s+alpha/);
    expect(out).not.toMatch(/PASS\s+[\d.]+s\s+ws-step/);
  });

  it('distinguishes a wrong version from an absent package', () => {
    const { code, out } = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
      packages: [{ path: 'node_modules/zod', version: '4.4.3', installedVersion: '3.0.0' }],
    });

    expect(code).toBe(1);
    expect(out).toContain('gate BLOCKED');
    // Both numbers, because "which one do I have" is the reader's next question.
    expect(out).toContain('have 3.0.0, lockfile pins 4.4.3');
    expect(out).not.toContain('NOT INSTALLED');
    expect(out).not.toMatch(/PASS\s+[\d.]+s\s+alpha/);
  });

  it('blocks when nothing has been installed at all', () => {
    const { code, out } = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
      uninstalled: true,
    });

    expect(code).toBe(1);
    expect(out).toContain('gate BLOCKED');
    expect(out).toContain('dependencies are not installed');
    expect(out).not.toMatch(/PASS\s+[\d.]+s\s+alpha/);
  });

  it('refuses to report a pass when it cannot make the comparison at all', () => {
    // No lockfile: the check has nothing to compare against. The failure mode
    // to avoid is treating "could not check" as "checked, fine".
    const { code, out } = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
      noLockfile: true,
    });

    expect(code).toBe(1);
    expect(out).toContain('could not run');
    expect(out).not.toContain('gate PASSED');
  });

  it('says nothing in the way when the tree is correctly installed', () => {
    const { code, out } = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
      packages: [{ path: PKG, version: '8.7.0', installedVersion: '8.7.0' }],
    });

    // The false-alarm case. A preflight that fires on a healthy tree gets
    // routed around, and then it is worse than not having one.
    expect(code).toBe(0);
    expect(out).toContain('gate PASSED');
    expect(out).not.toContain('BLOCKED');
    expect(out).toContain('node_modules matches package-lock.json');
  });

  it('does not require optional packages this machine would skip', () => {
    // Platform-specific optional packages are absent on a correctly installed
    // tree by design — npm installs only the entries whose os/cpu match. A
    // naive "every lockfile entry must exist" rule reports 100 of them as
    // failures against this repo's own lockfile, on a tree `npm ci` has just
    // written. That check would be routed around within a week.
    const { code, out } = runGate({
      scripts: { a: PASSES },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
      packages: [{ path: PKG, version: '8.7.0', installedVersion: '8.7.0' }],
      optionalAbsent: true,
    });

    expect(code).toBe(0);
    expect(out).toContain('gate PASSED');
  });
});

describe('run-gate: it refuses a plan that would check less than it claims', () => {
  const refuses = (opts: Parameters<typeof runGate>[0], expected: RegExp) => {
    const { code, out } = runGate(opts);
    expect(code).toBe(1);
    expect(out).not.toContain('gate PASSED');
    expect(out).toMatch(expected);
  };

  it('refuses an empty step list rather than passing everything', () => {
    refuses({ steps: [] }, /non-empty array/);
  });

  it('refuses a step naming a script that does not exist', () => {
    refuses(
      {
        scripts: { a: PASSES },
        wsScripts: { w: PASSES },
        steps: [step('typo', 'lnit'), wsStep('ws-step', 'w')],
      },
      /does not define/
    );
  });

  it('refuses when the plan’s workspaces disagree with package.json', () => {
    // The exact drift the explicit list has to guard: a second workspace is
    // added to package.json and nothing in the gate covers it.
    refuses(
      {
        scripts: { a: PASSES },
        wsScripts: { w: PASSES },
        steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
        workspacesInPlan: ['ws', 'mobile'],
      },
      /package\.json declares/
    );
  });

  it('refuses a declared workspace that has no steps of its own', () => {
    refuses(
      { scripts: { a: PASSES }, steps: [step('alpha', 'a')] },
      /workspace `ws` has no gate steps/
    );
  });

  it('refuses duplicate step ids, which would hide one result behind another', () => {
    refuses(
      {
        scripts: { a: PASSES, b: PASSES },
        wsScripts: { w: PASSES },
        steps: [step('same', 'a'), step('same', 'b'), wsStep('ws-step', 'w')],
      },
      /duplicate step id/
    );
  });

  it('refuses a negative or non-numeric weight', () => {
    refuses(
      {
        scripts: { a: PASSES },
        wsScripts: { w: PASSES },
        steps: [step('alpha', 'a', { weight: -1 }), wsStep('ws-step', 'w')],
      },
      /non-negative numeric `weight`/
    );
  });

  it('refuses a --jobs value that is not a positive number', () => {
    refuses(
      {
        scripts: { a: PASSES },
        wsScripts: { w: PASSES },
        steps: [step('alpha', 'a'), wsStep('ws-step', 'w')],
        args: ['--jobs', '0'],
      },
      /must be a positive number/
    );
  });
});

/**
 * Reads the pool width the runner announced in its header, which is the
 * number every scheduling assertion below is really about.
 */
function slotsIn(out: string): number {
  const m = /scheduled across (\d+) job slots?/.exec(out);
  if (!m) throw new Error(`no job-slot count in the gate's header:\n${out}`);
  return Number(m[1]);
}

/** A step that records when it starts and stops, so overlap is observable. */
const TRACED = (ms: number) =>
  "node -e \"const fs=require('fs'),f=process.env.GATE_TRACE;" +
  `fs.appendFileSync(f,'+');setTimeout(()=>fs.appendFileSync(f,'-'),${ms})"`;

/** The most steps that were ever running at once, from a TRACED trace. */
function maxOverlap(trace: string): number {
  let depth = 0;
  let peak = 0;
  for (const ch of trace) {
    if (ch === '+') peak = Math.max(peak, (depth += 1));
    else if (ch === '-') depth -= 1;
  }
  return peak;
}

describe('run-gate: it sizes itself for the machine it is on, not the machine it would have alone (#596)', () => {
  const CORES = availableParallelism();
  const trivial = {
    scripts: { a: PASSES },
    wsScripts: { w: PASSES },
    steps: [step('alpha', 'a'), wsStep('gamma', 'w')],
  };

  it('takes the whole machine when nothing else is gating on it', () => {
    const { code, out } = runGate({ ...trivial, env: { GATE_PEERS: '1' } });

    expect(code).toBe(0);
    expect(slotsIn(out)).toBe(CORES);
    // Nothing to share with, so nothing to say about sharing.
    expect(out).not.toContain('sharing');
  });

  it('divides the machine by the gate runs on it, and says that it did', () => {
    const { code, out } = runGate({ ...trivial, env: { GATE_PEERS: '3' } });

    expect(code).toBe(0);
    expect(slotsIn(out)).toBe(Math.max(1, Math.floor(CORES / 3)));
    expect(out).toContain('2 other gate runs');
  });

  it('never widens past --jobs, however empty the machine looks', () => {
    const { code, out } = runGate({ ...trivial, args: ['--jobs', '2'], env: { GATE_PEERS: '1' } });

    expect(code).toBe(0);
    expect(slotsIn(out)).toBe(2);
  });

  it('keeps a slot on a crowded machine, so a gate always makes progress', () => {
    const { code, out } = runGate({ ...trivial, env: { GATE_PEERS: '64' } });

    expect(code).toBe(0);
    expect(slotsIn(out)).toBe(1);
  });

  it('holds heavy steps to the narrowed width, not to --jobs', () => {
    const trace = join(mkdtempSync(join(tmpdir(), 'gate-trace-')), 'trace');
    writeFileSync(trace, '');

    const { code, out } = runGate({
      scripts: { h: TRACED(400) },
      wsScripts: { w: TRACED(400) },
      steps: [
        step('heavy-1', 'h', { weight: 2 }),
        step('heavy-2', 'h', { weight: 2 }),
        wsStep('heavy-3', 'w', { weight: 2 }),
      ],
      args: ['--jobs', '6'],
      env: { GATE_PEERS: '3', GATE_TRACE: trace },
    });

    expect(code).toBe(0);
    const slots = slotsIn(out);
    // Weight-2 steps, so the pool fits floor(slots / 2) of them — and at
    // least one, because a step heavier than the whole pool still runs alone.
    expect(maxOverlap(readFileSync(trace, 'utf8'))).toBeLessThanOrEqual(
      Math.max(1, Math.floor(slots / 2))
    );
  });

  it('tells each step how many gates share the machine, so its own pool can divide too', () => {
    const { code, out } = runGate({
      scripts: { a: 'node -e "console.log(\'peers=\' + process.env.GATE_PEERS)"' },
      wsScripts: { w: PASSES },
      steps: [step('alpha', 'a'), wsStep('gamma', 'w')],
      args: ['--verbose'],
      env: { GATE_PEERS: '3' },
    });

    expect(code).toBe(0);
    // frontend/vitest.config.ts reads exactly this to size its worker pool.
    expect(out).toContain('peers=3');
  });

  it('refuses a GATE_PEERS that is not a count, instead of quietly meaning something else', () => {
    const { code, out } = runGate({ ...trivial, env: { GATE_PEERS: 'lots' } });

    expect(code).not.toBe(0);
    expect(out).toContain('GATE_PEERS');
    expect(out).not.toContain('gate PASSED');
  });
});

/**
 * The census is the half of #596 that has to be right about the real machine,
 * so these run it against the real process table rather than a fixture.
 *
 * The property that matters is the one that made a process-table count
 * preferable to a lock file: a gate that dies stops being counted the instant
 * it dies, with nothing left behind to reclaim and no push left waiting on it.
 */
describe('gate-census: counting the gates on this machine (#596)', () => {
  interface Census {
    cores: number;
    peers: number;
    source: string;
    slots: number;
    pids: number[];
  }

  function census(args: string[] = [], env: Record<string, string> = {}, input = ''): Census {
    const out = execFileSync(process.execPath, [REAL_CENSUS, '--json', ...args], {
      encoding: 'utf8',
      input,
      // The suite itself runs under a gate, which sets GATE_PEERS; blank it so
      // these read the machine unless a case says otherwise.
      env: { ...process.env, GATE_PEERS: '', ...env },
    });
    return JSON.parse(out) as Census;
  }

  it('counts gate runners, and nothing that merely mentions one', () => {
    const { peers, pids } = census(
      ['--from-stdin'],
      {},
      [
        '  101 node /repo/scripts/run-gate.mjs',
        '  102 npm run verify',
        '  103 node scripts/run-gate.mjs --jobs 4',
        '  104 grep run-gate.mjs',
        '  105 /bin/zsh -c cd /w && node scripts/run-gate.mjs',
        '  106 node /other/scripts/gate-census.mjs',
        '  103 node scripts/run-gate.mjs --jobs 4',
        'not a process line at all',
      ].join('\n')
    );

    // 101 and 103 are gates. 102 has not reached the runner yet; 104 is
    // looking for one; 105 is the shell that will exec the 103-shaped process
    // and would double-count it; 106 is this module. 103 appears twice.
    expect(pids).toContain(101);
    expect(pids).toContain(103);
    expect(pids).not.toContain(104);
    expect(pids).not.toContain(105);
    // Plus the counting process itself, which is always its own peer.
    expect(peers).toBe(3);
  });

  it('sees a gate that is actually running, and stops seeing it the moment it dies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-census-'));
    const fakeRunner = join(dir, 'run-gate.mjs');
    // Named like the runner, because that is what the census matches on.
    writeFileSync(fakeRunner, 'setTimeout(() => {}, 60_000);\n');

    const kids = [
      spawn(process.execPath, [fakeRunner], { stdio: 'ignore' }),
      spawn(process.execPath, [fakeRunner], { stdio: 'ignore' }),
    ];
    const kidPids = kids.map((k) => k.pid as number);

    try {
      // `ps` sees a process a moment after spawn returns, so poll rather than
      // assume. Nothing here depends on what else is on the machine: the
      // assertions are about these two pids, not about the total.
      const deadline = Date.now() + 20_000;
      let seen = census().pids;
      while (Date.now() < deadline && !kidPids.every((pid) => seen.includes(pid))) {
        seen = census().pids;
      }
      expect(seen).toEqual(expect.arrayContaining(kidPids));
    } finally {
      for (const kid of kids) kid.kill('SIGKILL');
    }

    // No lock to release, no heartbeat to expire, no stale entry to reap: the
    // process table forgets them, so the census does too.
    const deadline = Date.now() + 20_000;
    let after = census().pids;
    while (Date.now() < deadline && kidPids.some((pid) => after.includes(pid))) {
      after = census().pids;
    }
    for (const pid of kidPids) expect(after).not.toContain(pid);
  });

  it('divides the cores it found by the gates it found', () => {
    const { cores, peers, slots } = census(
      ['--from-stdin'],
      {},
      ['  201 node scripts/run-gate.mjs', '  202 node scripts/run-gate.mjs'].join('\n')
    );

    expect(peers).toBe(3);
    expect(slots).toBe(Math.max(1, Math.floor(cores / 3)));
  });

  it('lets an override replace the count, and says the number came from there', () => {
    const { peers, source, slots, cores } = census([], { GATE_PEERS: '4' });

    expect(peers).toBe(4);
    expect(source).toBe('env');
    expect(slots).toBe(Math.max(1, Math.floor(cores / 4)));
  });

  it('rejects an override that is not a count rather than guessing one', () => {
    expect(() => census([], { GATE_PEERS: '0' })).toThrow();
    expect(() => census([], { GATE_PEERS: 'many' })).toThrow();
  });
});

/**
 * The third of #596's fix directions, and the smallest: a run whose failures
 * are all deadlines, on a machine that is oversubscribed, can say so. It does
 * not change the result — from inside the runner a starved gate and a broken
 * change are indistinguishable, and guessing would be the "gate that cannot
 * fail" defect this file exists to prevent. It changes what the reader is
 * told, which is the difference between a gate that looks like it is lying
 * about your change and one that says it was busy and how to check.
 */
describe('run-gate: it can tell a starved run from a broken one, without excusing either (#596)', () => {
  /** A step that fails the way a starved jsdom test does. */
  const TIMED_OUT =
    'node -e "console.error(\'Error: Test timed out in 15000ms.\'); process.exit(1)"';
  /** Narrowed by 64 gate runs from a ceiling of 64: oversubscribed anywhere. */
  const CROWDED = { args: ['--jobs', '64'], env: { GATE_PEERS: '64' } };

  it('names the contention when every failure is a deadline and the machine is shared', () => {
    const { code, out } = runGate({
      scripts: { t: TIMED_OUT },
      wsScripts: { w: PASSES },
      steps: [step('slow', 't', { weight: 2 }), wsStep('gamma', 'w')],
      ...CROWDED,
    });

    expect(out).toContain('Every failure above is a timeout');
    expect(out).toContain('64 quality gates on it');
    // And it does not soften the result by one degree.
    expect(code).toBe(1);
    expect(out).toContain('gate FAILED');
    expect(out).toContain('the push is still refused');
  });

  it('says nothing about contention for a failure that is not a deadline', () => {
    const { code, out } = runGate({
      scripts: { f: FAILS },
      wsScripts: { w: PASSES },
      steps: [step('broken', 'f', { weight: 2 }), wsStep('gamma', 'w')],
      ...CROWDED,
    });

    expect(code).toBe(1);
    expect(out).toContain('the thing is wrong');
    expect(out).not.toContain('Every failure above is a timeout');
  });

  it('says nothing when only SOME of the failures are deadlines', () => {
    // One real regression in the run is enough: the reader is owed a report
    // about their change, not an explanation about the machine.
    const { code, out } = runGate({
      scripts: { t: TIMED_OUT, f: FAILS },
      wsScripts: { w: PASSES },
      steps: [step('slow', 't', { weight: 2 }), step('broken', 'f'), wsStep('gamma', 'w')],
      ...CROWDED,
    });

    expect(code).toBe(1);
    expect(out).not.toContain('Every failure above is a timeout');
  });
});
