// ESLint Flat Config (ESLint v9+) for the repository
// - Applies TypeScript linting to the collector service
// - Coordinates with Prettier via eslint-config-prettier (no formatting rules here)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // Global ignores for the repo
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'bids_output/**',
      '**/.venv/**',
    ],
  },

  // Base JS recommendations
  js.configs.recommended,

  // TypeScript (type-aware) recommendations
  ...tseslint.configs.recommendedTypeChecked,

  // Project-specific overrides for the collector service
  {
    files: ['collector/**/*.ts'],
    languageOptions: {
      // Node runtime
      globals: globals.node,
      parserOptions: {
        // Use project service for type-aware linting without listing every tsconfig
        projectService: true,
        tsconfigRootDir: new URL('./collector', import.meta.url),
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Disable rules that conflict with Prettier formatting
  eslintConfigPrettier,
];

