module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
    // strict (not just recommended) so accessibility regressions fail CI.
    'plugin:jsx-a11y/strict',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./tsconfig.json', './tsconfig.node.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['react-refresh', 'jsx-a11y'],
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
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
  overrides: [
    {
      // i18n enforcement is opt-in per-folder while we migrate. Areas in
      // this allowlist MUST use `t()` for user-visible strings; English
      // literals in JSX trigger a build-blocking error. The Help FAQ is
      // *deliberately* not enrolled — translating curated articles is a
      // separate workstream from translating UI chrome.
      files: ['src/features/settings/PreferencesSettings.tsx'],
      plugins: ['i18next'],
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
    },
  ],
};
