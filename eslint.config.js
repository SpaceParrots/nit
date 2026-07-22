import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'nit-review', 'nit-review-merged', '.playwright-mcp'] },
  js.configs.recommended,

  // Type-aware linting for the TypeScript sources.
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // `.catch(() => {})` / best-effort cleanup callbacks are idiomatic here.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      // main.ts assembles `ui` after the closures that capture it.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // Public APIs carry explicit types; locals may infer.
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // The bridge/MCP boundary logs untrusted values inside template literals.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
    },
  },

  // Shared style rules (JS + TS alike).
  {
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
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

  // Plain-JS files (tests, this config): base rules only, no type information.
  {
    files: ['**/*.js'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  {
    // Code that runs inside the inspected page (bundled into the overlay).
    files: ['src/overlay/**/*.ts', 'src/capture/target.ts', 'src/anchor/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Node-side code, CLI, tests and this config file.
    files: ['src/browser/**/*.ts', 'src/store/**/*.ts', 'src/cli/**/*.ts', 'src/mcp/**/*.ts', 'src/util/**/*.ts', 'src/capture/screenshot.ts', 'test/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Node files that embed page.evaluate callbacks (those run in the browser).
    files: ['src/browser/**/*.ts', 'test/browser-*.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
