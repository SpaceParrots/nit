import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
  { ignores: ['node_modules', 'nit-review', 'nit-review-merged', '.playwright-mcp', 'examples'] },
  js.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'smart'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/keyword-spacing': 'error',
    },
  },
  {
    // Code that runs inside the inspected page (bundled into the overlay).
    files: ['src/overlay/**/*.js', 'src/capture/target.js', 'src/anchor/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Node-side code, CLI, tests and this config file.
    files: ['src/browser/**/*.js', 'src/store/**/*.js', 'src/cli/**/*.js', 'src/mcp/**/*.js', 'src/capture/screenshot.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Node files that embed page.evaluate callbacks (those run in the browser).
    files: ['src/browser/**/*.js', 'test/browser-*.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
