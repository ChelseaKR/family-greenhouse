/**
 * How many quality gates are running on this machine right now, and therefore
 * how much of it any one of them may take.
 *
 * The problem this solves (#596). `scripts/run-gate.mjs` sizes its job pool
 * from `availableParallelism()`, and `frontend/vitest.config.ts` sizes its
 * worker pool the same way. `availableParallelism()` reports the machine's
 * cores. It does not report the machine's FREE cores, and nothing coordinated
 * across gate runs, so every concurrent `npm run verify` sized itself as
 * though it had the laptop to itself. Three of them produced three times the
 * demand against one machine's supply. Measured while filing the issue: three
 * `run-gate.mjs`, three `vitest --coverage` at ~190% CPU each, ten cores, load
 * average 131 — and jsdom render-and-query tests missing deadlines at random
 * in whichever of the three happened to be scheduled worst. Those failures
 * blocked pushes on branches that touched no frontend file at all.
 *
 * The fix is to make the sizing assumption true: divide the machine by the
 * number of gates on it. `peers()` counts them; `jobBudget()` does the
 * division; `run-gate.mjs` re-asks on every scheduling pass, so a gate that
 * started alone narrows when company arrives, and widens again when it leaves.
 *
 * WHY THE PROCESS TABLE, AND NOT A LOCK
 *
 * The obvious implementation is a lock file, or a counting semaphore, under
 * the OS temp directory: acquire before a heavy step, release after. It works,
 * and it has one failure mode that is worse than the flakiness it replaces —
 * a gate killed at the wrong moment (^C during a push, a laptop asleep, an
 * OOM) leaves the lock held, and every future push on the machine hangs behind
 * a process that no longer exists. Guarding that needs stale detection, a
 * heartbeat, a reclaim policy, an acquire timeout and an escape hatch, and
 * every one of those is a new way for the gate to be wrong.
 *
 * So there is no shared state here at all. The kernel already maintains an
 * exact, self-cleaning registry of the running gates — the process table — and
 * a gate that dies leaves it instantly, with nothing to reap. This module
 * reads it. Nothing is held, so nothing can be held too long; nothing is
 * acquired, so nothing can fail to be released; no gate ever waits for
 * another. The worst case if `ps` is missing, slow, or unparseable is
 * `peers() === 1`, which is exactly the behaviour this repo had before.
 *
 * That is also why this narrows pools instead of queueing steps. A queue makes
 * one gate wait on another's progress, which is a liveness dependency between
 * unrelated pushes; dividing the pool does not. Three gates each take a third
 * of the machine and all three finish, slower than one alone and much faster
 * than three fighting.
 *
 * Overrides, in order of precedence:
 *
 *   GATE_PEERS=<n>   Skip the count and use <n>. `GATE_PEERS=1` restores the
 *                    old take-the-whole-machine behaviour; the gate says so in
 *                    its header either way, so an override is never silent.
 *
 * As a command, for when a gate's sizing needs explaining:
 *
 *   node scripts/gate-census.mjs            # one human-readable line
 *   node scripts/gate-census.mjs --json     # the same, machine-readable
 *   ps -Ao pid=,args= | node scripts/gate-census.mjs --from-stdin
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/**
 * The gate runner's filename. A process is a gate if its command line names
 * this file — which covers `npm run verify`, `node scripts/run-gate.mjs`, the
 * pre-push hook and any absolute-path invocation, because every one of them
 * ends up as an argv entry pointing at this file.
 */
export const RUNNER_FILENAME = 'run-gate.mjs';

/**
 * Command lines that mention the runner but are not a gate.
 *
 * Two kinds. Tools that mention it because they are LOOKING for it — `ps`
 * itself, greps, `pgrep` — and the shell that was asked to start one, which on
 * some invocations shows up alongside the `node` process it exec'd and would
 * otherwise count the same gate twice. Matched against the whole command line,
 * so a false positive here only ever UNDERCOUNTS, which lands on the wider
 * pool this repo used before #596 rather than on a narrower one.
 */
const NOT_A_GATE =
  /(^|\/)(ps|grep|egrep|fgrep|rg|ugrep|pgrep|ag|ack|sh|bash|zsh|dash|ksh|fish|xargs|watch)\b/;

/**
 * The pids of the gate runners in `ps` output.
 *
 * Expects one process per line as `<pid> <command line>`, i.e. the output of
 * `ps -Ao pid=,args=`. Unparseable lines are skipped rather than guessed at:
 * a miscount here only changes how wide a pool is, so the safe direction on
 * doubt is to undercount and behave as the gate did before.
 *
 * @param {string} psOutput
 * @param {number} selfPid  Included even if the caller is not a gate, so a
 *   caller is always at least its own peer and `jobBudget` never divides by
 *   zero.
 * @returns {number[]} Ascending, deduplicated, never empty.
 */
export function gatePids(psOutput, selfPid) {
  const pids = new Set([selfPid]);
  for (const line of String(psOutput).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, command] = m;
    if (!command.includes(RUNNER_FILENAME)) continue;
    if (NOT_A_GATE.test(command)) continue;
    pids.add(Number(pid));
  }
  return [...pids].sort((a, b) => a - b);
}

/**
 * How many gate runners are in `ps` output. See `gatePids`.
 *
 * @param {string} psOutput
 * @param {number} selfPid
 * @returns {number} At least 1.
 */
export function countGates(psOutput, selfPid) {
  return gatePids(psOutput, selfPid).length;
}

/** Reads the process table. Returns '' if it cannot, which means "just me". */
function psOutput() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,args='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * How many gate runs share this machine, including the caller.
 *
 * Never throws and never returns less than 1: every failure path — no `ps`,
 * a `ps` that times out, an unreadable override — lands on 1, the number this
 * repo assumed unconditionally before #596.
 *
 * @param {{ env?: NodeJS.ProcessEnv, pid?: number }} [options]
 * @returns {{ peers: number, source: 'env' | 'ps', pids: number[] }} `pids` is
 *   empty when the count came from an override rather than from the machine.
 */
export function peers(options = {}) {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;

  const override = env.GATE_PEERS;
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 1) return { peers: Math.floor(n), source: 'env', pids: [] };
    // A typo in an override must not silently mean something else.
    throw new Error(`GATE_PEERS must be a number >= 1, got "${override}".`);
  }

  const pids = gatePids(psOutput(), pid);
  return { peers: pids.length, source: 'ps', pids };
}

/**
 * The share of the machine one gate may take.
 *
 * `ceiling` is what the gate would have used on an empty machine — its
 * `--jobs`, `GATE_JOBS`, or `availableParallelism()`. The census can only
 * narrow it, never widen it, so an explicit `--jobs 2` still means at most 2.
 *
 * A gate alone gets `floor(cores / 1)` and so keeps its ceiling exactly: the
 * single-gate case is unchanged by this module, which is what makes it safe to
 * put on a path every push takes.
 *
 * @param {{ cores?: number, peers?: number, ceiling?: number }} [options]
 * @returns {number} At least 1 — a gate always makes progress.
 */
export function jobBudget(options = {}) {
  const cores = Math.max(1, Math.floor(options.cores ?? availableParallelism()));
  const gates = Math.max(1, Math.floor(options.peers ?? 1));
  const ceiling = Math.max(1, Math.floor(options.ceiling ?? cores));
  return Math.max(1, Math.min(ceiling, Math.floor(cores / gates)));
}

// --- as a command ----------------------------------------------------------

function isMain() {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('gate-census.mjs');
}

if (isMain()) {
  try {
    const argv = process.argv.slice(2);
    const cores = availableParallelism();
    let found;
    if (argv.includes('--from-stdin')) {
      const pids = gatePids(readFileSync(0, 'utf8'), process.pid);
      found = { peers: pids.length, source: 'stdin', pids };
    } else {
      found = peers();
    }
    const slots = jobBudget({ cores, peers: found.peers });
    if (argv.includes('--json')) {
      console.log(
        JSON.stringify({
          cores,
          peers: found.peers,
          source: found.source,
          slots,
          pids: found.pids,
        })
      );
    } else {
      const others = found.peers - 1;
      console.log(
        `${cores} cores, ${found.peers} gate run${found.peers === 1 ? '' : 's'}` +
          `${others > 0 ? ` (${others} besides this process)` : ''} → ` +
          `${slots} job slot${slots === 1 ? '' : 's'} each [counted from ${found.source}]`
      );
    }
  } catch (err) {
    // A stack trace here would be noise: every throw in this module is a bad
    // override, which is a thing the reader typed.
    console.error(`gate-census: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
