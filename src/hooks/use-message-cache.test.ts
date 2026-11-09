/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { readSnapshotEntry } from './use-message-cache'

describe('readSnapshotEntry', () => {
  const cache = {
    'linkPreview/https://example.com': { title: 'Example' },
    'weatherForecast/Lisbon/Lisbon/PT/c/pt-BR': { days: [] },
  }

  it('reads the exact entry the sharer stored', () => {
    expect(readSnapshotEntry(cache, 'linkPreview/https://example.com', undefined)).toEqual({ title: 'Example' })
  })

  it('falls back to the entry under the prefix when the viewer-specific tail differs', () => {
    expect(
      readSnapshotEntry(cache, 'weatherForecast/Lisbon/Lisbon/PT/f/en', ['weatherForecast', 'Lisbon', 'Lisbon', 'PT']),
    ).toEqual({ days: [] })
  })

  it('is null on a miss, so nothing is fetched for the recipient', () => {
    expect(readSnapshotEntry(cache, 'linkPreview/https://other.example', undefined)).toBeNull()
    expect(readSnapshotEntry(undefined, 'linkPreview/https://example.com', undefined)).toBeNull()
  })
})
