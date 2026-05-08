/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import js from '@eslint/js'
import typescript from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'

/**
 * Shared TypeScript config for frontend and backend.
 * Platform-specific configs (React, Storybook, Node globals) are added in each eslint.config.js.
 */
export const sharedTypescriptConfig = {
  languageOptions: {
    parser: typescriptParser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  plugins: {
    '@typescript-eslint': typescript,
  },
  rules: {
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
        format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
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
  },
}

/** Base configs that both FE and BE should start with */
export const baseConfigs = [js.configs.recommended, prettier]
