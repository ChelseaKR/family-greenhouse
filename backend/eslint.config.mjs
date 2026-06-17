import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config (ESLint 10). Mirrors the previous .eslintrc.cjs:
//   eslint:recommended + @typescript-eslint recommended + recommended-requiring-type-checking
export default tseslint.config(
  {
    // Replaces the old `ignorePatterns`. The config file itself
    // (eslint.config.mjs) is ignored by ESLint by default.
    ignores: ['dist', 'esbuild.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting against the backend tsconfig, scoped to this
        // workspace regardless of the directory ESLint is invoked from.
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
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
    // The local Express mock is a dev-only tool — it is never deployed (the
    // build pipeline runs esbuild on the Lambda handlers only) and it carries
    // a file-level `@ts-nocheck` by design, which collapses every value to
    // `any`. The type-aware rules below therefore fire across the whole file
    // without surfacing real risk; console output is intentional for a dev
    // server. See the header comment in local-server.ts for the rationale.
    files: ['src/local-server.ts'],
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
  }
);
