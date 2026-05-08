/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import globals from 'globals'
import { baseConfigs, sharedTypescriptConfig } from '../shared/eslint/base.js'

export default [
  ...baseConfigs,
  {
    ...sharedTypescriptConfig,
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['node_modules', 'dist'],
    languageOptions: {
      ...sharedTypescriptConfig.languageOptions,
      globals: {
        ...globals.node,
        ...globals.es2022,
        BodyInit: 'readonly',
        RequestInfo: 'readonly',
        RequestInit: 'readonly',
      },
    },
  },
]
