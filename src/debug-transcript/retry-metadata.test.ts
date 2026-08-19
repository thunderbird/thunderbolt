/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { emptyResponseRetryReason } from './retry-metadata'

describe('debug transcript retry metadata', () => {
  it('uses the transcript retry reason spelling', () => {
    expect(emptyResponseRetryReason).toBe('empty-response')
  })
})
