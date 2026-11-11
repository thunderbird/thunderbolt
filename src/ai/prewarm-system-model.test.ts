/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { prewarmSystemModel } from './prewarm-system-model'

describe('prewarmSystemModel', () => {
  it.each([
    ['no model', null],
    ['a non-Tinfoil model', { provider: 'openai', isSystem: 1 } as const],
    ['a user Tinfoil model', { provider: 'tinfoil', isSystem: 0 } as const],
  ])('skips warm-up for %s', async (_label, model) => {
    await expect(prewarmSystemModel(model)).resolves.toBeUndefined()
  })
})
