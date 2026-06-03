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
      thresholds: {
        lines: 65,
        statements: 65,
        branches: 65,
        functions: 55,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
