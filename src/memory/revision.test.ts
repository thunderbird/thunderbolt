/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getMemoryRevision } from './revision'

describe('opaque memory revisions', () => {
  it('uses a stable SHA-256 token without echoing user content', async () => {
    expect(await getMemoryRevision('')).toBe('m1-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await getMemoryRevision('Secret preference')).toMatch(/^m1-[a-f0-9]{64}$/)
    expect(await getMemoryRevision('Café 🙂')).toBe(await getMemoryRevision('Café 🙂'))
  })

  it('distinguishes trailing whitespace and Unicode normalization without changing the document', async () => {
    const revisions = await Promise.all(['A', 'A ', 'A\n', 'A\r\n', 'é', 'e\u0301'].map(getMemoryRevision))
    expect(new Set(revisions).size).toBe(revisions.length)
  })
})
