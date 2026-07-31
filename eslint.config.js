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
    files: ['src/renderer/**/*.js', '*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    }
  },
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn'
    }
  }
];
