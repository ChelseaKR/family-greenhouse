#!/usr/bin/env node
/**
 * Assigns `tests/e2e/*.spec.ts` files to one of N CI shards, balanced by
 * REAL measured runtime instead of Playwright's own `--shard=X/Y`, which
 * divides the alphabetically-sorted test list into N equal-COUNT chunks.
 *
 * ## Why this exists
 *
 * Measured on 15 consecutive `main` CI runs (2026-09-16, run ids
 * 34906167717..35173550972, `Run e2e + a11y suite` step durations): shard 1
 * averaged 101.8s, shard 4 averaged 69.7s — shard 1 was the slowest of the
 * four in every single run, and `e2e-a11y`/`e2e-report` (ci.yml) both wait on
 * `needs: [e2e-shard]`, so every run's E2E wall clock was gated on shard 1's
 * time whether or not it happened to be the overall pipeline's bottleneck.
 *
 * The cause: `a11y-authenticated.spec.ts` and `a11y.spec.ts` sort first
 * alphabetically and are two of the three heaviest files by real duration
 * (49.1s and 36.9s respectively, out of 231.4s total — a merged-blob-report
 * measurement from run 35173550972, see WEIGHTS_MS below), so Playwright's
 * equal-COUNT split put a disproportionate share of the suite's actual
 * runtime in shard 1 no matter how the remaining lighter files fell.
 *
 * ## What this does instead
 *
 * A checked-in table of each spec file's last-measured duration (ms), fed
 * into a longest-processing-time-first (LPT) greedy bin-packing over N
 * shards. Re-run on the same 2026-09-16 measurement: shards come out at
 * 58.2s / 58.2s / 56.9s / 58.2s — the ~32s spread (104s vs 70s) collapses to
 * ~1s, because the two heavy a11y files land in different shards instead of
 * both effectively loading shard 1.
 *
 * ## The failure mode this must NOT reintroduce (#472)
 *
 * A spec file that silently runs in NO shard is a coverage gap that stays
 * green — exactly the class of bug #472 fixed for npm test scripts
 * (`tests:wired:check`). A file missing from WEIGHTS_MS is not a bug: it
 * gets DEFAULT_WEIGHT_MS (the measured median) and is still scheduled. What
 * would be a bug is a file discovered on disk that ends up assigned to zero
 * shards or more than one — `planAllShards()` below asserts the full
 * discovered set is covered exactly once, every time this script runs, and
 * throws loudly rather than letting a partition bug ship quietly.
 *
 * ## Usage
 *
 *   node scripts/e2e-shard-plan.mjs <shardNumber 1..N> <totalShards>
 *
 * Prints the space-separated spec filenames for that shard to stdout, bare
 * (e.g. `a11y.spec.ts`, not `tests/e2e/a11y.spec.ts`) — Playwright's CLI
 * matches positional arguments as a regex against each test's path relative
 * to `testDir`, and a `tests/e2e/` prefix does not match there (verified:
 * `npx playwright test tests/e2e/a11y.spec.ts --list` reports "No tests
 * found"; `npx playwright test a11y.spec.ts --list` finds it). For direct
 * use as `playwright test` positional arguments. Deterministic: same inputs
 * always produce the same partition, so each of the N parallel CI jobs can
 * call this independently with no cross-job coordination.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = join(FRONTEND, 'tests', 'e2e');

// Keep in sync with playwright.config.ts's `testIgnore`. Both files these
// name run under dedicated configs (production smoke, deterministic store
// screenshots) and are never part of the default sharded sweep.
const IGNORED = new Set(['post-deploy-smoke.spec.ts', 'store-screenshots.spec.ts']);

// Real per-file durations (ms), summed across every test in the file, from
// the merged Playwright blob report of run 35173550972 (2026-09-16,
// `main`, all four shards combined so every file's total is the file's real
// total regardless of which shard happened to run it that day). Re-measure
// and update when the suite's shape changes enough for shard 1 to drift
// slow again — this table is a snapshot, not a live signal.
const WEIGHTS_MS = {
  'a11y-authenticated.spec.ts': 49100,
  'visual.spec.ts': 44800,
  'a11y.spec.ts': 36900,
  'responsive-ux.spec.ts': 22000,
  'integration-functionality.spec.ts': 12500,
  'reflow.spec.ts': 10900,
  'notification-browser-surfaces.spec.ts': 7600,
  'plant-crud.spec.ts': 6700,
  'auth.spec.ts': 4400,
  'task-completion.spec.ts': 4200,
  'foreground-notification-timing.spec.ts': 3900,
  'join-second-household.spec.ts': 3600,
  'reduced-motion.spec.ts': 3600,
  'no-care-data.spec.ts': 3600,
  'keyboard-path.spec.ts': 3400,
  'create-plant.spec.ts': 3400,
  'pricing-interval.spec.ts': 3300,
  'register-flow.spec.ts': 2100,
  'space-overview.spec.ts': 2000,
  'happy-path.spec.ts': 1800,
  'shared-care-pulse.spec.ts': 1700,
  // Self-skips under CI (macOS-only baselines) — genuinely ~0 real time.
  'visual-regression.spec.ts': 0,
};

// Median of WEIGHTS_MS's values on 2026-09-16, for a spec this script
// discovers on disk but has no measurement for (new file, not yet
// re-measured). Deliberately not 0: a new, unmeasured file defaulting to
// "free" would make every future rebalance ignore it, unbalancing shard 1
// (or whichever shard it lands in) all over again. A new file still needs
// re-measuring and adding above; this just keeps the schedule reasonable
// until someone does.
const DEFAULT_WEIGHT_MS = 3750;

function discoverSpecFiles() {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts') && !IGNORED.has(name))
    .sort(); // deterministic input order regardless of OS directory iteration order
}

/** Longest-processing-time-first greedy bin packing into `totalShards` bins. */
function planAllShards(files, totalShards) {
  const bins = Array.from({ length: totalShards }, () => ({ files: [], totalMs: 0 }));
  const weighted = files
    .map((f) => ({ file: f, ms: WEIGHTS_MS[f] ?? DEFAULT_WEIGHT_MS }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));

  for (const { file, ms } of weighted) {
    // Lightest bin so far; tie-break on lowest index so the result is stable.
    let lightest = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].totalMs < bins[lightest].totalMs) lightest = i;
    }
    bins[lightest].files.push(file);
    bins[lightest].totalMs += ms;
  }

  // The invariant that matters (#472-class): every discovered file assigned
  // to exactly one shard. A partition bug here must fail loudly, not ship a
  // shard silently missing a file.
  const assigned = bins.flatMap((b) => b.files);
  const assignedSet = new Set(assigned);
  if (assigned.length !== files.length || assignedSet.size !== files.length) {
    throw new Error(
      `e2e-shard-plan: partition invariant violated — discovered ${files.length} spec ` +
        `files but assigned ${assigned.length} (${assignedSet.size} unique) across ` +
        `${totalShards} shards. This must never ship a shard silently missing a file; ` +
        'fix planAllShards() rather than working around this check.'
    );
  }
  const missing = files.filter((f) => !assignedSet.has(f));
  if (missing.length > 0) {
    throw new Error(
      `e2e-shard-plan: these discovered files were not assigned: ${missing.join(', ')}`
    );
  }

  return bins;
}

function main() {
  const [shardArg, totalArg] = process.argv.slice(2);
  const shardNumber = Number(shardArg);
  const totalShards = Number(totalArg);
  if (
    !Number.isInteger(shardNumber) ||
    !Number.isInteger(totalShards) ||
    shardNumber < 1 ||
    shardNumber > totalShards
  ) {
    console.error('Usage: node scripts/e2e-shard-plan.mjs <shardNumber 1..N> <totalShards>');
    process.exit(1);
  }

  const files = discoverSpecFiles();
  const bins = planAllShards(files, totalShards);
  const chosen = bins[shardNumber - 1];

  // Visible on the Actions log for every run — turns "why is shard 2 slow
  // today" from an investigation into a scroll-up.
  for (let i = 0; i < bins.length; i++) {
    const label = i === shardNumber - 1 ? '>>' : '  ';
    console.error(
      `${label} shard ${i + 1}: ${(bins[i].totalMs / 1000).toFixed(1)}s planned, ${bins[i].files.length} files`
    );
  }

  console.log(chosen.files.join(' '));
}

main();
