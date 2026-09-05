import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { availableParallelism } from 'node:os';
import { resolve } from 'path';

// How many quality gates share this machine right now, as counted by
// scripts/gate-census.mjs and handed down by scripts/run-gate.mjs. Absent —
// CI, `npm test` by hand, an editor's test runner — it is 1, and every number
// below is exactly what it was before #596.
//
// This is read rather than counted here on purpose: the gate does the counting
// once, for all of its steps, and a config file that shells out to `ps` every
// time vitest loads it would be a surprising thing for `npm test` to do.
const gateRuns = Math.max(1, Math.floor(Number(process.env.GATE_PEERS)) || 1);

// Pin the test timezone to one that observes DST so the date-math
// regression tests (tests/unit/utils/date.dst.test.ts) actually exercise
// the fall-back/spring-forward transitions. This must happen here — in the
// MAIN vitest process, whose real environment worker threads inherit —
// because inside workers `process.env` is a proxied snapshot and assigning
// TZ there never reaches the native tzset. An explicitly exported TZ
// (e.g. from CI) is respected; the DST suite skips itself in that case.
process.env.TZ ??= 'America/New_York';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    // Keep the jsdom files inside a bounded thread pool. The fork pool
    // intermittently times out while starting or terminating child processes
    // on laptops and shared CI runners before tests execute; worker threads
    // are cheap to start and have never shown that failure.
    pool: 'threads',
    // Run those files across the pool instead of one at a time. The serial
    // setting was introduced alongside the fork -> thread switch above, but the
    // instability it was working around was the *fork* pool's process
    // start/stop, not concurrency — the thread pool never had it, so serial
    // execution was paying for a problem it did not solve.
    //
    // What it cost, measured on the `Test Frontend` runner (157 files, 1214
    // tests, 203s wall clock):
    //
    //   environment  67.2s   jsdom construction, per file
    //   tests        51.7s   the actual test bodies
    //   setup        36.6s   tests/setup.ts, per file
    //   import       20.3s
    //   transform     2.7s
    //
    // Only a quarter of the run is test bodies; the rest is per-file fixed cost
    // that a serial runner pays end to end on one core (measured at 114% CPU)
    // and a parallel one amortises across the runner's vCPUs.
    //
    // This does not weaken the gate. `isolate` stays at its default, so each
    // file still gets a fresh jsdom and a fresh module registry — the same
    // isolation serial execution gave, just several at a time. Every file still
    // runs, in one process, under one v8 coverage collection, so the coverage
    // thresholds below are still computed over the whole suite. Sharding across
    // runners would have been the other way to parallelise this, and was
    // rejected precisely because it splits that coverage computation: a
    // per-shard percentage is not the suite's percentage, and stitching the
    // reports back together is a new way for the coverage gate to end up
    // measuring less than it claims.
    //
    // TZ (set above, in the main process) is unaffected: worker threads inherit
    // the real environment however many of them there are.
    //
    // Give a test more than vitest's 5s default. Almost nothing here needs it:
    // the suite runs 1214 tests in ~70s of actual test time, about 58ms each.
    // But these are jsdom render-and-query tests, and on a contended machine
    // the wait is for a CPU slice, not for the code under test. Measured on a
    // 10-core laptop at load average 97 — several agents each running the full
    // `npm run verify` — a single run produced 37 failures across ten files,
    // 28 of them literally `Test timed out in 5000ms` and the rest
    // `findBy*` queries expiring on the same starvation. That run had no
    // frontend changes in it at all; it was blocking an unrelated push.
    //
    // This does not weaken anything. No test here asserts a duration, so a
    // longer ceiling cannot make a broken test pass — it only stops a busy
    // machine failing a correct one, which is the failure that teaches people
    // to reach for `--no-verify`. `backend/vitest.config.ts` made the same
    // call at 10s for the same reason; 15s here because the jsdom render path
    // starves harder than the backend's in-memory Express roundtrips.
    //
    // Deliberately NOT paired with a `retry`. A retry would hide a genuinely
    // flaky test rather than reveal it, and this repo has a checker for gates
    // that quietly stop failing.
    testTimeout: 15_000,
    //
    // Cap the pool rather than letting it take the whole machine. On the CI
    // runner this suite is the only thing running and the default is right,
    // but `npm run verify` (scripts/run-gate.mjs) now runs it concurrently
    // with the backend suite, two tsc passes and two eslint passes, so an
    // uncapped pool on a developer's laptop just moves the contention instead
    // of removing it. Halving and capping at four was the setting measured
    // locally: 157 files in 58-81s across ten runs on a 10-core machine,
    // against 263s serial, with the v8 coverage totals identical to the
    // decimal (82.41 / 75.44 / 75.58 / 83.29) every time — which is the check
    // that the schedule is not changing what the suite exercises.
    //
    // The halving also keeps CI where this landed: a 2-vCPU runner resolves
    // to a single worker and a 4-vCPU one to two, so `Test Frontend` is not
    // re-tuned by this.
    //
    // Divided again by the number of gate runs sharing the machine (#596).
    // `availableParallelism()` reports cores, not FREE cores, so the cap above
    // was four workers per gate however many gates there were: three
    // concurrent `npm run verify` runs put twelve jsdom workers plus three
    // coverage passes on ten cores, measured at load average 131. That is not
    // a slower suite, it is a different one — `NotificationSettings.test.tsx`
    // takes 9.35s alone and was measured at 56.29s with nothing else in its
    // own gate competing with it, and at that ratio a `findBy*` query stops
    // waiting for the code under test and starts waiting for a CPU slice.
    //
    // Raising `testTimeout` again would not have reached the other half of it:
    // in vitest 4.1.11 the pool runner's own START_TIMEOUT/STOP_TIMEOUT are
    // module-level 60s constants passed straight to `withTimeout`, with no
    // config path at all, so a worker that is starved while STARTING kills the
    // whole run — including files the change never touched. Less contention is
    // the only thing that reaches that.
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2 / gateRuns))),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/setup.ts',
        'tests/e2e/**',
        'src/main.tsx',
        // Build-time SSR entry, same category as main.tsx: a bootstrap module
        // that only runs inside `vite build --ssr` + scripts/prerender.mjs.
        // Its output IS gated — scripts/check-prerender-coverage.mjs asserts
        // every rendered page's markup and metadata on every build — and its
        // one piece of real logic (the head serializer) lives in
        // src/config/seo.ts, which is unit-tested.
        'src/entry-server.tsx',
        'src/sentry.ts',
        '**/*.config.*',
        '**/sw.ts',
        'dist/**',
      ],
      // Ratchet (CQ-16, P1-5 — both defined in README "Standards conformance",
      // see its "Finding IDs" note): measured 2026-08-04 on the `Test Frontend`
      // runner (Linux, Node 22 — the gate of record) is lines 77.86 /
      // statements 77.11 / branches 67.65 / functions 68.61. That measurement
      // is now stable run to run; PlantNameNursery's spec used to draw names
      // from the real Math.random, so whether its reroll-retry loop ran moved
      // this total by a line/statement/branch between identical runs.
      //
      // A local run may report one more covered line/statement (77.89 / 77.14)
      // because `src/i18n/index.ts` takes its localStorage `catch` on some
      // hosts and not others — a pre-existing host difference, visible in
      // main's CI runs too, worth 0.03pp and no floor.
      //
      // Floors set ~2pp below the measurement (not jump-cut to the standard's
      // 80x4-perFile target, which just breeds exclusions). Raise ~5pp per
      // release with a tracked issue; see README "Standards conformance"
      // (CODE-QUALITY row). Previous rung (2026-07-05): 65 / 64 / 59 / 57
      // against a 67.34 / 66.75 / 61.46 / 59.04 measurement; this rung came
      // from covering the chat stream parser, the telemetry vitals/error rail,
      // client-side image downscaling, the notification wrapper, locale
      // formatting, UI prefs, and the untested service write paths.
      thresholds: {
        lines: 76,
        statements: 75,
        branches: 65,
        functions: 66,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@/components': resolve(__dirname, './src/components'),
      '@/features': resolve(__dirname, './src/features'),
      '@/hooks': resolve(__dirname, './src/hooks'),
      '@/services': resolve(__dirname, './src/services'),
      '@/store': resolve(__dirname, './src/store'),
      '@/utils': resolve(__dirname, './src/utils'),
    },
  },
});
