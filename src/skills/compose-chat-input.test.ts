/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { appendSlashToken } from './compose-chat-input'

describe('appendSlashToken', () => {
  it('returns just the token (plus trailing space) for an empty input', () => {
    expect(appendSlashToken('', 'meeting-notes')).toBe('/meeting-notes ')
  })

  it('returns just the token when the input already holds only that token (no doubling)', () => {
    expect(appendSlashToken('/meeting-notes', 'meeting-notes')).toBe('/meeting-notes ')
    expect(appendSlashToken('  /meeting-notes  ', 'meeting-notes')).toBe('/meeting-notes ')
  })

  it('appends the token with a single space when the input has other content', () => {
    expect(appendSlashToken('summarize this', 'meeting-notes')).toBe('summarize this /meeting-notes ')
  })

  it('collapses trailing whitespace on existing content to a single space', () => {
    expect(appendSlashToken('summarize this   ', 'meeting-notes')).toBe('summarize this /meeting-notes ')
    expect(appendSlashToken('summarize this\n\n', 'meeting-notes')).toBe('summarize this /meeting-notes ')
  })

  it('leaves a different existing slash token in place when appending another', () => {
    expect(appendSlashToken('/weekly-review', 'meeting-notes')).toBe('/weekly-review /meeting-notes ')
  })

  it('appends correctly across newlines', () => {
    expect(appendSlashToken('first line\nsecond line', 'meeting-notes')).toBe('first line\nsecond line /meeting-notes ')
  })
})
