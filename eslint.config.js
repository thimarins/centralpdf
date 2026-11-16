const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-installer/**',
      'dist-installer-test/**',
      'output/**',
      'reports/**',
      '.tmp-test-runs/**',
      'releases/**',
      'test-assets/generated/**',
      'src/renderer/vendor/**'
    ]
  },
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    files: ['src/renderer/**/*.js', 'src/renderer/**/*.mjs', '*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    }
  },
  {
    rules: {
      // Catch blocks are frequently used as best-effort cleanup/fallbacks.
      // They do not need a fake variable just to satisfy lint; unused locals
      // and function arguments remain reported normally.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn'
    }
  }
];
