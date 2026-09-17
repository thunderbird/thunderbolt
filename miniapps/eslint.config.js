/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import js from '@eslint/js'
import typescript from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import { sharedParserOptions, sharedRules } from '../shared/eslint/base.js'

/**
 * Lint config for the Mini App packages.
 *
 * Its own config rather than an entry in the root one, matching how `backend/`
 * is set up: these are browser packages that install separately, so the root
 * `eslint src shared` never sees them. Without this they would be linted by
 * nothing and the conventions would hold only until the next edit.
 */
export default [
  js.configs.recommended,
  prettier,
  {
    files: ['sdk/src/**/*.{ts,tsx}', 'template/**/*.{ts,tsx}', 'samples/**/*.{ts,tsx}'],
    ignores: ['**/node_modules/**', '**/.next/**', '**/next-env.d.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { ...sharedParserOptions, ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
    },
    rules: {
      ...sharedRules,
      // A Mini App is framed by Thunderbolt and speaks to it over postMessage.
      // `window.parent.postMessage(payload, '*')` would broadcast app state to
      // whatever page happens to be framing us, so the bridge always targets a
      // resolved origin — see `hostOrigin` in sdk/src/bridge.ts.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='postMessage'] > Literal[value='*']",
          message: "Never postMessage to '*' — target the resolved host origin.",
        },
      ],
    },
  },
]
