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
// config exists so that the husky + lint-staged pre-commit hook — which runs
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
