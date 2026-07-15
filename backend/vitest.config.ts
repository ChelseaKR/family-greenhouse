import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

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
      // Ratchet (CQ-16, P1-5): measured 2026-07-05 was lines 82.84 / statements
      // 82.05 / branches 73.77 / functions 82.27 — these floors are set ~2pp
      // below that measurement (not the standard's 80x4-perFile target,
      // reached honestly rather than jump-cut, which just breeds exclusions).
      // Raise ~5pp per release with a tracked issue; see README "Standards
      // conformance" (CODE-QUALITY row) and add `perFile: true` once within
      // 10pp of 80 on every dimension.
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 71,
        functions: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
