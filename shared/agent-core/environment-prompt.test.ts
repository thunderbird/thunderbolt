/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { APP_HARNESS_ENVIRONMENT_PROMPT } from './environment-prompt.ts'

describe('APP_HARNESS_ENVIRONMENT_PROMPT', () => {
  it('documents sandbox network constraints without assuming optional web tools exist', () => {
    expect(APP_HARNESS_ENVIRONMENT_PROMPT).toContain('no network access')
    expect(APP_HARNESS_ENVIRONMENT_PROMPT).toContain('`curl` and `wget` are unavailable')
    expect(APP_HARNESS_ENVIRONMENT_PROMPT).toContain('when available')
  })
})
