// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from 'eslint-plugin-storybook'

import js from '@eslint/js'
import typescript from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  js.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['node_modules', 'dist', 'dist-isolation', 'src-tauri', 'backend'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        React: 'readonly',
        // TypeScript types
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
      react: {
        version: 'detect',
      },
    },
    rules: {
      // TypeScript rules
      // Turn off base rules that conflict with TypeScript equivalents
      'no-unused-vars': 'off',
      'no-redeclare': 'off', // Turn off base rule for TypeScript overloads
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_', // fn args like (_evt)
          varsIgnorePattern: '^_', // variables like const _x = ...
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_', // catch ( _err ) { ... }
          ignoreRestSiblings: true, // const { used, ..._rest } = obj
        },
      ],
      '@typescript-eslint/no-redeclare': 'error', // Use TypeScript-aware version
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // React rules
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      // React Hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // General rules
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-async-promise-executor': 'off',
      // Prevent importing React as default
      'no-restricted-imports': [
        'error',
        {
          name: 'react',
          importNames: ['default'],
          message: 'Do not import default React. Use named imports instead.',
        },
      ],
      // Enforce type imports to always use the `type` keyword
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          disallowTypeAnnotations: false,
        },
      ],
    },
  },
  ...storybook.configs['flat/recommended'],
]
