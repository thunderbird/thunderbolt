/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getLoadingLabel } from './loading-labels'

describe('getLoadingLabel', () => {
  it('returns a specific label for search mode', () => {
    expect(getLoadingLabel('search')).toBe('Searching the web…')
  })

  it('returns a specific label for research mode', () => {
    expect(getLoadingLabel('research')).toBe('Researching…')
  })

  it('returns undefined for chat mode (keeps the plain spinner)', () => {
    expect(getLoadingLabel('chat')).toBeUndefined()
  })

  it('returns undefined for unknown/custom modes (no fabricated label)', () => {
    expect(getLoadingLabel('my-custom-mode')).toBeUndefined()
    expect(getLoadingLabel('')).toBeUndefined()
  })
})
