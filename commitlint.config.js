module.exports = {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes "chore(deps): Bump x from 1 to 2" — capital B trips
  // subject-case and there's no upstream setting to change it. The repo
  // squash-merges, so the human-edited PR title is what lands on main;
  // skipping dependabot's own branch commits costs nothing.
  ignores: [(message) => /^chore\(deps.*\): Bump /.test(message)],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // New feature
        'fix', // Bug fix
        'docs', // Documentation
        'style', // Formatting, missing semicolons, etc.
        'refactor', // Code refactoring
        'perf', // Performance improvements
        'test', // Adding tests
        'chore', // Maintenance tasks
        'ci', // CI/CD changes
        'build', // Build system changes
        'revert', // Revert previous commit
      ],
    ],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
    'header-max-length': [2, 'always', 100],
  },
};
