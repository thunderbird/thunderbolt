/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from 'eslint-plugin-storybook'

import js from '@eslint/js'
import typescript from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import { sharedParserOptions, sharedRules } from './shared/eslint/base.js'

export default [
  js.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['node_modules', 'dist', 'dist-isolation', 'src-tauri', 'thunderbird-*', 'backend'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ...sharedParserOptions,
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        React: 'readonly',
        Bun: 'readonly',
        NodeJS: 'readonly',
        RequestInfo: 'readonly',
        RequestInit: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...sharedRules,

      // React
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Frontend-specific restrictions
      'no-restricted-imports': [
        'error',
        {
          name: 'react',
          importNames: ['default'],
          message: 'Do not import default React. Use named imports instead.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ExpressionStatement > Literal[value='use client']",
          message: "'use client' is not needed in Vite — remove it.",
        },
        {
          selector: "MemberExpression[object.name='React']",
          message:
            "React namespace access is not allowed. Use direct imports instead (e.g. import { type ReactNode } from 'react').",
        },
        {
          selector: "TSQualifiedName[left.name='React']",
          message:
            "React namespace access in types is not allowed. Use direct imports instead (e.g. import { type ReactNode } from 'react').",
        },
      ],
    },
  },
  ...storybook.configs['flat/recommended'],
]
