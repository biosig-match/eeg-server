// ESLint Flat Config (ESLint v9+) for the repository
// - Applies TypeScript linting to the collector service
// - Coordinates with Prettier via eslint-config-prettier (no formatting rules here)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

const tsServices = [
  'auth_manager',
  'collector',
  'data_linker',
  'event_corrector',
  'integration_test',
  'media_processor',
  'processor',
  'session_manager',
  'stimulus_asset_processor',
  'observability_dashboard',
];

const tsFileGlobs = tsServices.flatMap((service) => [
  `${service}/**/*.ts`,
  `${service}/**/*.tsx`,
  `${service}/**/*.mts`,
  `${service}/**/*.cts`,
]);

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
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: tsFileGlobs,
    languageOptions: {
      ...(config.languageOptions ?? {}),
      globals: globals.node,
    },
  })),
  {
    files: tsFileGlobs,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Project-specific overrides for each TypeScript service
  ...tsServices.map((service) => ({
    files: [
      `${service}/**/*.ts`,
      `${service}/**/*.tsx`,
      `${service}/**/*.mts`,
      `${service}/**/*.cts`,
    ],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  })),

  // Disable rules that conflict with Prettier formatting
  eslintConfigPrettier,
];
