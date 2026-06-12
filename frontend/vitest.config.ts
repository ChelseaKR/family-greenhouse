import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/setup.ts',
        'tests/e2e/**',
        'src/main.tsx',
        'src/sentry.ts',
        '**/*.config.*',
        '**/sw.ts',
        'dist/**',
      ],
      thresholds: {
        lines: 24,
        statements: 24,
        branches: 60,
        functions: 30,
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
