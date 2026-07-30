/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { appHarnessEnvironmentPrompt } from './environment-prompt.ts'

describe('appHarnessEnvironmentPrompt', () => {
  it('documents sandbox network constraints without assuming optional web tools exist', () => {
    expect(appHarnessEnvironmentPrompt).toContain('no network access')
    expect(appHarnessEnvironmentPrompt).toContain('`curl` and `wget` are unavailable')
    expect(appHarnessEnvironmentPrompt).toContain('when available')
  })
})
