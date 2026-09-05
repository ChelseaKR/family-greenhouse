import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Root flat config (ESLint 10).
//
// SCOPE: this file lints only the files that have no workspace config above
// them — `scripts/**/*.mjs` and `infrastructure/**/lambda/*.mjs`. That is all.
//
// ESLint 10 resolves the NEAREST config file to each linted file, so anything
// under `backend/` or `frontend/` is linted by that workspace's own
// eslint.config.mjs — including when the path is ABSOLUTE, which is the form
// the lint-staged pre-commit hook passes. Measured with `eslint --debug`:
//
//   backend/src/services/apiKeys.ts -> backend/eslint.config.mjs
//   frontend/src/main.tsx           -> frontend/eslint.config.mjs
//   backend/scripts/*.mjs           -> backend/eslint.config.mjs
//   scripts/run-gate.mjs            -> this file
//
// This config used to MIRROR both workspaces' rule sets, justified by "flat
// config does not auto-discover nested config files" and by the pre-commit
// hook needing to lint staged files from both workspaces with the same rules.
// That premise does not hold on ESLint 10, and the mirror was removed in #584.
//
// It mattered because the mirror was a duplicated ruleset with no feedback
// loop: never applied to the files it mirrored, so it could drift from the
// real workspace configs with no run in which the two disagreed visibly, and a
// rule added here for `backend/src` would have been dead on arrival. The
// workspace configs were always the ones doing the work — edit those.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'backend/esbuild.config.js',
      'frontend/**/*.config.{js,ts}',
    ],
  },

  // ---- Plain-ESM tooling and Lambdas: **/*.mjs (#443) ----
  //
  // Every static check in this repo was scoped to `src`. Twenty-four `.mjs`
  // files sat outside all of them: `tsc --noEmit` never sees a `.mjs`, the
  // per-workspace `lint` scripts are `eslint src`, and this config's `files`
  // globs were `backend/src/**` and `frontend/src/**`. `prettier --write .`
  // covered them, which is formatting, not correctness.
  //
  // Thirteen of those files ARE the gates. The only code path in a gate script
  // that throws is its FAILURE branch — precisely the branch a green build
  // never executes. A ReferenceError in the "report a violation and exit 1" arm
  // of check-no-silenced-gates.mjs would sit there indefinitely: every run takes
  // the happy path, exits 0, and the gate is reported as passing while being
  // incapable of failing. Two more are Lambdas that run in production, one of
  // which carries security@ mail.
  //
  // No type-aware rules: these are plain ESM and are in no tsconfig program.
  // `no-undef` is the rule that earns this block — it is what catches a typo in
  // an error path that nothing executes.
  //
  // `npm run lint:scripts` also passes `frontend/scripts/**/*.mjs` and
  // `backend/scripts/**/*.mjs`, which are deliberately NOT listed below: they
  // sit under a workspace, so nearest-config resolution hands them to
  // frontend/ or backend/eslint.config.mjs, each of which has its own
  // `files: ['scripts/**/*.mjs']` block. Listing them here would look like
  // coverage while providing none. If you are adding a rule for those files,
  // add it to the workspace config that actually lints them.
  {
    files: ['scripts/**/*.mjs', 'infrastructure/**/lambda/*.mjs'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        // `tseslint.config()` installs the TypeScript parser for every file in
        // this config, including these. That is harmless for parsing, but its
        // project service then looks for a tsconfig to own each file and aborts
        // on the workspace ones ("multiple candidate TSConfigRootDirs"). These
        // files are in no tsconfig program and want no type information, so the
        // service is switched off explicitly and the root is named.
        projectService: false,
        project: null,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // These are CLI tools and Lambdas; console IS the interface.
      'no-console': 'off',
    },
  }
);
