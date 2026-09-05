/**
 * The local quality gate's step list — the single source of truth for what
 * `npm run verify` (and therefore `.githooks/pre-push`) runs.
 *
 * Every step is an npm script invoked exactly as npm would invoke it, so the
 * gate can never drift from the workspace's own definition of `lint` or
 * `typecheck`: change `frontend/package.json` and the gate follows. The cost
 * is npm's ~0.4s per-invocation startup, which is free here because the steps
 * run concurrently (see scripts/run-gate.mjs).
 *
 * `verify` used to be a fifteen-link `&&` chain. Nothing about that ordering
 * was load-bearing — every step is a read-only check of files on disk, the
 * only writes are each workspace's own `coverage/` directory, and no step
 * consumes another's output. Timed step by step on a 10-core laptop the chain
 * came to 305s, and 315-319s end to end; `test:coverage` alone was 259s of
 * that. Nearly all of it was one core busy and nine idle.
 *
 * `weight` is the share of the machine a step is expected to occupy, used by
 * the runner's scheduler:
 *
 *   2  a vitest run (`--coverage` adds a v8 instrumentation pass on top of
 *      the worker threads)
 *   1  a single-threaded compiler or linter pass (tsc, eslint, prettier)
 *   0  a small node script that reads files and exits, or a step that spends
 *      its time on the network rather than the CPU (`audit`). These are not
 *      scheduled at all — they start immediately, so a broken marker or a
 *      stale doc fails the gate in a couple of seconds instead of queueing
 *      behind the test suites.
 *
 * WORKSPACES is asserted against package.json's own `workspaces` array by the
 * runner. The old chain used `--workspaces --if-present`, which silently
 * covered any workspace that appeared later; this list is explicit, so the
 * assertion is what keeps a third workspace from being quietly skipped.
 */

/** Must equal package.json's `workspaces`, or the runner refuses to start. */
export const WORKSPACES = ['frontend', 'backend'];

/**
 * @typedef {object} GateStep
 * @property {string}  id        Name shown in the gate's output.
 * @property {string}  script    npm script to run.
 * @property {string} [workspace] Workspace to run it in; omitted = repo root.
 * @property {number}  weight    Scheduler cost; 0 = start immediately.
 * @property {string}  why       What this step catches, for the failure report.
 */

/** @type {GateStep[]} */
export const STEPS = [
  // --- Long poles first: started before anything else so everything cheap
  // --- overlaps with them rather than queueing after them.
  {
    id: 'test:frontend',
    script: 'test:coverage',
    workspace: 'frontend',
    weight: 2,
    why: 'frontend unit/integration tests and the frontend coverage floors',
  },
  {
    id: 'test:backend',
    script: 'test:coverage',
    workspace: 'backend',
    weight: 2,
    why: 'backend unit/integration/eval tests and the backend coverage floors',
  },
  {
    id: 'typecheck:frontend',
    script: 'typecheck',
    workspace: 'frontend',
    weight: 1,
    why: 'TypeScript errors in frontend/src',
  },
  {
    id: 'typecheck:backend',
    script: 'typecheck',
    workspace: 'backend',
    weight: 1,
    why: 'TypeScript errors in backend/src',
  },
  {
    id: 'lint:frontend',
    script: 'lint',
    workspace: 'frontend',
    weight: 1,
    why: 'ESLint errors and warnings in frontend/src',
  },
  {
    id: 'lint:backend',
    script: 'lint',
    workspace: 'backend',
    weight: 1,
    why: 'ESLint errors and warnings in backend/src',
  },
  {
    id: 'format:check',
    script: 'format:check',
    weight: 1,
    why: 'Prettier formatting across the repo',
  },

  // --- Cheap checks: unscheduled, so they report in seconds.
  {
    id: 'hooks:check',
    script: 'hooks:check',
    weight: 0,
    why: 'the pre-push hook wiring itself — core.hooksPath pointing at a tracked, executable, gate-running hook (#544)',
  },
  {
    id: 'i18n:check',
    script: 'i18n:check',
    weight: 0,
    why: 'i18n catalog parity and the hardcoded-string ratchet',
  },
  {
    id: 'reads:check:frontend',
    script: 'reads:check',
    workspace: 'frontend',
    weight: 0,
    why: 'ADR 0010 settled-read-state ratchet (useQuery results)',
  },
  {
    id: 'reads:check:backend',
    script: 'reads:check',
    workspace: 'backend',
    weight: 0,
    why: 'ADR 0010 settled-read-state ratchet (DynamoDB/SSM/Cognito/fetch reads)',
  },
  {
    id: 'observability:check',
    script: 'observability:check',
    weight: 0,
    why: 'the observability and SLO contract',
  },
  {
    id: 'audit',
    script: 'audit:check',
    weight: 0,
    why: 'high/critical advisories in production dependencies',
  },
  {
    id: 'markers:check',
    script: 'markers:check',
    weight: 0,
    why: 'bare TODO/FIXME/HACK markers with no issue reference',
  },
  {
    id: 'gates:check',
    script: 'gates:check',
    weight: 0,
    why: 'silenced test/security/lint gates in the workflows',
  },
  {
    id: 'docs:testing:check',
    script: 'docs:testing:check',
    weight: 0,
    why: 'docs/testing.md drifting from the suite and the coverage floors',
  },
  {
    id: 'figures:check',
    script: 'figures:check',
    weight: 0,
    why: 'documentation figures that no longer match their source',
  },
  {
    id: 'api:check',
    script: 'api:check',
    weight: 0,
    why: 'handler routes missing from the API spec',
  },
  {
    id: 'sitemap:check',
    script: 'sitemap:check',
    workspace: 'frontend',
    weight: 0,
    why: 'the committed sitemap drifting from the route table',
  },
  {
    id: 'brand:check',
    script: 'brand:check',
    workspace: 'frontend',
    weight: 0,
    why: 'brand assets drifting from their sources',
  },
  {
    id: 'mobile:validate',
    script: 'mobile:validate',
    weight: 0,
    why: 'native version parity, store listing metadata, and the store-build config',
  },
];
