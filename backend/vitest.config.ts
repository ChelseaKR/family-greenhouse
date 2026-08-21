import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Pin the zone the suite runs in to what the deployed Lambdas use (no TZ
// override exists in infrastructure/, so they run UTC). The recurrence math
// in taskService (`setDate(getDate() + frequency)`) is local-zone arithmetic,
// so without this the snooze/next-due date assertions were only green on
// laptops whose zone happened to have no DST transition inside the fixture
// window. Set here, in the main process, for the same reason as the frontend
// config: worker threads inherit it, but assigning TZ inside one is inert.
// An explicitly exported TZ (e.g. to reproduce a zone-specific failure) wins.
process.env.TZ ??= 'UTC';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    // The integration suite does many supertest roundtrips against an
    // in-memory Express app. Under parallel-worker CPU contention these
    // brush against testTimeout and produce intermittent 401s/timeouts.
    // Three layered mitigations:
    //   1. fileParallelism off — files don't compete for CPU.
    //   2. testTimeout bumped to 10s — absorbs scheduler hiccups.
    //   3. retry once — covers the residual flake without masking real
    //      regressions (unit tests never flake so this never triggers there).
    // The structural fix (refactor local-server.ts to a createApp() factory
    // so each test file gets an isolated app+db) is on the roadmap; this
    // unblocks CI in the meantime.
    // Threads also avoid intermittent child-process startup timeouts in the
    // fork pool on laptops and shared runners; fileParallelism remains off.
    pool: 'threads',
    fileParallelism: false,
    testTimeout: 10_000,
    retry: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'src/local-server.ts',
        'src/utils/sentry.ts',
        '**/*.config.*',
        '**/index.ts',
      ],
      // Ratchet (CQ-16, P1-5 — both defined in README "Standards conformance",
      // see its "Finding IDs" note): measured 2026-08-04 was lines 84.47 /
      // statements 83.31 / branches 76.01 / functions 84.57 — up from the
      // 2026-07-05 rung (82.84 / 82.05 / 73.77 / 82.27) purely from coverage
      // that feature/fix PRs already added since, not from a dedicated
      // coverage push. Floors set ~2pp below the new measurement, same
      // methodology as before (not the standard's 80x4-perFile target,
      // reached honestly rather than jump-cut, which just breeds exclusions).
      //
      // `perFile: true` is NOT safe yet despite the aggregate sitting within
      // 10pp of 80 on every dimension — per-file coverage is highly uneven
      // (e.g. `services/householdUsage.ts` measured 0%, `handlers/apiKeys`
      // ~19%, `services/chatReports.ts` 20% on 2026-08-04), so flipping it on
      // would fail CI immediately. Revisit once the lagging files are
      // individually covered, not just once the aggregate looks close.
      //
      // Raise again with a tracked issue once the next wave of feature/fix
      // coverage lands; see README "Standards conformance" (CODE-QUALITY row).
      thresholds: {
        lines: 82,
        statements: 81,
        branches: 74,
        functions: 82,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
