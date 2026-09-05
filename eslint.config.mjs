import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import i18next from 'eslint-plugin-i18next';

// Root flat config (ESLint 10).
//
// The per-workspace `npm run lint` scripts run from inside each workspace and
// resolve frontend/eslint.config.mjs or backend/eslint.config.mjs. This root
// config exists so that the lint-staged pre-commit hook (.githooks/pre-commit) —
// which runs
// `eslint --fix backend/src/x.ts frontend/src/y.tsx` from the repo root — lints
// staged files in BOTH workspaces with the same rules. Flat config does not
// auto-discover nested config files, so the workspace rule sets are mirrored
// here, scoped by path and pointed at each workspace's tsconfig.
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.join(rootDir, 'frontend');
const backendDir = path.join(rootDir, 'backend');

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
  {
    files: [
      'scripts/**/*.mjs',
      'frontend/scripts/**/*.mjs',
      'backend/scripts/**/*.mjs',
      'infrastructure/**/lambda/*.mjs',
    ],
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
  },

  // ---- Backend: src/**/*.ts ----
  {
    files: ['backend/src/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: backendDir,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // Dev-only Express mock — see backend/eslint.config.mjs for rationale.
    files: ['backend/src/local-server.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
    },
  },

  // ---- Frontend: src/**/*.{ts,tsx} ----
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
      jsxA11y.flatConfigs.strict,
    ],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: frontendDir,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: {
      // Pinned to the installed React major — ESLint 10 removed
      // context.getFilename(), which eslint-plugin-react's 'detect' path still
      // calls. See frontend/eslint.config.mjs.
      react: { version: '19.2' },
    },
    rules: {
      // Preserve the original react-hooks/recommended (v4) behaviour — see
      // frontend/eslint.config.mjs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'jsx-a11y/anchor-is-valid': [
        'error',
        {
          components: ['Link'],
          specialLink: ['to'],
          aspects: ['noHref', 'invalidHref'],
        },
      ],
      'react/no-unescaped-entities': 'off',
      'jsx-a11y/img-redundant-alt': 'off',
      'jsx-a11y/no-redundant-roles': 'off',
    },
  },
  {
    // i18n enforcement is opt-in per-folder — see frontend/eslint.config.mjs.
    //
    // Scope, precisely: `markupOnly: true` restricts this rule to JSX TEXT
    // NODES, and `ignoreAttribute` below is an EXCLUSION list, not a coverage
    // list. So this rule checks no attributes at all. Attribute coverage
    // (aria-label, alt, title, placeholder) is a per-file ratchet in
    // frontend/scripts/check-hardcoded-strings.mjs — see docs/i18n.md.
    files: ['frontend/src/features/settings/PreferencesSettings.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          markupOnly: true,
          ignoreAttribute: [
            'data-testid',
            'aria-label',
            'role',
            'name',
            'id',
            'type',
            'href',
            'to',
            'placeholder',
            'autoComplete',
            'inputMode',
            'pattern',
          ],
        },
      ],
    },
  }
);
