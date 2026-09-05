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
      // Every exclusion names a file, so a reader can judge it. `**/index.ts`
      // used to sit here and read as a barrel-file exclusion — in most
      // codebases that is exactly what it is. In this tree the ONLY file it
      // matched under src/ was `services/chat/index.ts`: 1,159 lines carrying
      // runChatTurn, the Bedrock tool loop, SYSTEM_PROMPT, the budget
      // reserve/reconcile, and the GROUNDING_BLOCK / PET_SAFETY_BLOCK
      // substitution — ADR 0011's entire enforcement point, the mechanism that
      // stops the assistant telling someone a plant is safe for their cat.
      // Deleting every chat test in the repo would not have moved a single
      // number below. A glob that hides its subject is the problem; these
      // name theirs.
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'src/local-server.ts',
        'src/utils/sentry.ts',
        '**/*.config.*',
      ],
      // Ratchet (CQ-16, P1-5 — both defined in README "Standards conformance",
      // see its "Finding IDs" note). Rungs, each measured and then floored
      // ~2pp below, never jump-cut to the standard's 80x4-perFile target
      // (which just breeds exclusions):
      //
      //   2026-07-05   82.84 / 82.05 / 73.77 / 82.27   floors 80/80/71/80
      //   2026-08-04   84.47 / 83.31 / 76.01 / 84.57   floors 82/81/74/82
      //   2026-09-04   89.68 / 88.89 / 80.77 / 91.03   floors 87/86/78/89
      //
      // (lines / statements / branches / functions.) The 2026-09-04 rung is
      // the first measured with `services/chat/index.ts` INCLUDED — see the
      // exclusion note above. Including it moved the aggregate UP, by about a
      // tenth of a point on each dimension: the file measures 90.99 / 82.54 /
      // 96.87 / 91.49, above the suite average. So the problem the exclusion
      // caused was never that the file was untested. It was that nothing
      // required it to STAY tested, on the highest-consequence code in the
      // backend and the only code that produces free-form text to a user.
      //
      // Hence the per-file floor below it. `perFile: true` GLOBALLY is still
      // not safe — per-file coverage is uneven (`services/householdUsage.ts`
      // measured 0%, `handlers/apiKeys` ~19% on 2026-08-04) — but a targeted
      // floor on the one file where an untested branch has the worst
      // consequence is a smaller, different commitment, and it is what makes
      // "did anyone test the branch that blocks an ungrounded pet-safety
      // claim" a question the gate actually asks.
      thresholds: {
        lines: 87,
        statements: 86,
        branches: 78,
        functions: 89,
        // ADR 0011's enforcement point. Floors ~2pp below its 2026-09-04
        // measurement, same methodology as the aggregate. Deleting the chat
        // tests now reddens CI here first, and says which file.
        'src/services/chat/index.ts': {
          lines: 89,
          statements: 88,
          branches: 80,
          functions: 94,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
