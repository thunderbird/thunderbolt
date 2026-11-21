/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { expect, it } from 'bun:test'
import { getToolMetadataSync } from './tool-metadata'

it('labels an Office script while receiving input and during execution', () => {
  for (const input of [undefined, { script: 'create()' }]) {
    expect(i18n._(getToolMetadataSync('run_office_script', input).loadingMessage)).toBe('Creating file…')
  }
})
