/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import js from '@eslint/js'
import typescript from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import { sharedParserOptions, sharedRules } from '../shared/eslint/base.js'

export default [
  js.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['node_modules', 'dist'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: sharedParserOptions,
      globals: {
        ...globals.node,
        ...globals.es2022,
        BodyInit: 'readonly',
        HeadersInit: 'readonly',
        RequestInfo: 'readonly',
        RequestInit: 'readonly',
        // Bun runtime globals
        Bun: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
    },
    rules: {
      ...sharedRules,
      // The backend has no Babel pass, so a Lingui macro import resolves to the
      // stub and throws when called. `shouldSkipEmail()` short-circuits in dev
      // and test, so that failure would first surface in production on the
      // sign-in path. See `src/emails/i18n.ts`.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@lingui/*/macro'],
              message: 'No macro transform on the backend — use i18n._({ id }) from @lingui/core.',
            },
          ],
        },
      ],
    },
  },
]
