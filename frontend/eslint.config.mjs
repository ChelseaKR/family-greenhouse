import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import i18next from 'eslint-plugin-i18next';

// Flat config (ESLint 10). Mirrors the previous .eslintrc.cjs:
//   eslint:recommended + @typescript-eslint recommended + react/recommended +
//   react/jsx-runtime + react-hooks/recommended + jsx-a11y/strict
export default tseslint.config(
  {
    // Replaces the old `ignorePatterns`. The config file itself is ignored
    // by ESLint by default.
    ignores: ['dist'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  jsxA11y.flatConfigs.strict,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        // Type-aware linting scoped to this workspace regardless of the
        // directory ESLint is invoked from.
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: {
      react: {
        // Pinned to the installed React major instead of 'detect'. ESLint 10
        // removed context.getFilename(), which eslint-plugin-react's 'detect'
        // codepath still calls; an explicit version skips that path. Bump this
        // when React is upgraded.
        version: '19.2',
      },
    },
    rules: {
      // Preserve the original `plugin:react-hooks/recommended` (v4) behaviour:
      // just these two rules. react-hooks v7 also ships React Compiler rules,
      // which are intentionally NOT enabled here — that is a separate opt-in.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'jsx-a11y/anchor-is-valid': [
        'error',
        {
          components: ['Link'],
          specialLink: ['to'],
          // Marketing footer carries `href="#"` placeholders the marketing
          // team will fill in. Allow them rather than fail builds on
          // copy-only PRs.
          aspects: ['noHref', 'invalidHref'],
        },
      ],
      // Renders fine in React; the cosmetic gain of escaping every apostrophe
      // doesn't justify the lint noise.
      'react/no-unescaped-entities': 'off',
      // "Photo of {plant.name}" is descriptive, not redundant. The rule
      // fires on the literal word "photo" but our alt text is genuinely
      // useful for screen readers.
      'jsx-a11y/img-redundant-alt': 'off',
      // Lists in our codebase consistently carry `role="list"` because
      // Tailwind's reset removes implicit list semantics in some browsers.
      // Keep the redundant role; it's defense-in-depth.
      'jsx-a11y/no-redundant-roles': 'off',
    },
  },
  {
    // i18n enforcement is opt-in per-folder while we migrate. Areas in
    // this allowlist MUST use `t()` for user-visible strings; English
    // literals in JSX trigger a build-blocking error. The Help FAQ is
    // *deliberately* not enrolled — translating curated articles is a
    // separate workstream from translating UI chrome.
    files: ['src/features/settings/PreferencesSettings.tsx'],
    plugins: {
      i18next,
    },
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
