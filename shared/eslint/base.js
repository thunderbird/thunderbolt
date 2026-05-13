/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared ESLint rules for frontend and backend.
 *
 * This file exports plain config objects only — no npm package imports.
 * Each eslint.config.js imports its own packages (parser, plugins, prettier)
 * so that Node module resolution works from each package's node_modules.
 */

/** Shared parser options for TypeScript */
export const sharedParserOptions = {
  ecmaVersion: 'latest',
  sourceType: 'module',
}

/** Shared ESLint rules matching CLAUDE.md conventions */
export const sharedRules = {
  // --- TypeScript base rule overrides ---
  'no-undef': 'off', // TypeScript handles this
  'no-unused-vars': 'off',
  'no-redeclare': 'off', // Turn off base rule for TypeScript overloads
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      args: 'all',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  '@typescript-eslint/no-redeclare': 'error',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      prefer: 'type-imports',
      disallowTypeAnnotations: false,
    },
  ],
  '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
  '@typescript-eslint/naming-convention': [
    'error',
    {
      selector: 'variable',
      format: ['camelCase'],
      leadingUnderscore: 'allow',
    },
    {
      selector: 'variable',
      modifiers: ['const'],
      format: ['camelCase', 'PascalCase'],
      custom: {
        regex: '^[A-Z][A-Z0-9]*$',
        match: false, // reject single-word all-caps (e.g. SCOPES, HELLO)
      },
      filter: {
        regex: '^[A-Z]',
        match: true,
      },
    },
    {
      selector: 'typeLike',
      format: ['PascalCase'],
    },
    {
      selector: 'function',
      format: ['camelCase', 'PascalCase'],
    },
  ],

  // --- General rules ---
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  'prefer-const': 'error',
  'no-async-promise-executor': 'off',
  curly: ['error', 'all'],
  'no-else-return': ['error', { allowElseIf: false }],
  'func-style': ['error', 'expression', { allowArrowFunctions: true }],
  'max-depth': ['warn', 4],
}
