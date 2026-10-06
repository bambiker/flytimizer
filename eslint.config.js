// Lint rules: ESLint's recommended set. Site code runs in the browser
// with Leaflet (L) and JSZip loaded as globals; tests and config run
// in Node.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'playwright-report/', 'test-results/'] },
  js.configs.recommended,
  {
    rules: {
      // Empty catch blocks are deliberate (storage or clipboard not
      // available is fine), so neither the block nor its error variable
      // needs to be used.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none' }]
    }
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, L: 'readonly', JSZip: 'readonly' }
    }
  },
  {
    files: ['tests/**/*.js', '*.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    }
  }
];
