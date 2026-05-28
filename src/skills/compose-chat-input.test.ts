/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { appendSlashToken } from './compose-chat-input'

describe('appendSlashToken', () => {
  it('returns just the token (plus trailing space) for an empty input', () => {
    expect(appendSlashToken('', 'daily-brief')).toBe('/daily-brief ')
  })

  it('returns the same input when the last token already matches the slug (clicking the same chip twice)', () => {
    expect(appendSlashToken('/daily-brief ', 'daily-brief')).toBe('/daily-brief ')
    expect(appendSlashToken('/daily-brief', 'daily-brief')).toBe('/daily-brief ')
    expect(appendSlashToken('hi /daily-brief ', 'daily-brief')).toBe('hi /daily-brief ')
    expect(appendSlashToken('hi /daily-brief', 'daily-brief')).toBe('hi /daily-brief ')
  })

  it('does NOT keep appending when the user alternates between two chips and the last one is repeated', () => {
    // Click daily-brief, then important-emails, then important-emails again.
    let v = ''
    v = appendSlashToken(v, 'daily-brief')
    v = appendSlashToken(v, 'important-emails')
    v = appendSlashToken(v, 'important-emails')
    expect(v).toBe('/daily-brief /important-emails ')
  })

  it('appends the token with a single space when the last token differs', () => {
    expect(appendSlashToken('/daily-brief ', 'important-emails')).toBe('/daily-brief /important-emails ')
    expect(appendSlashToken('summarize this', 'daily-brief')).toBe('summarize this /daily-brief ')
  })

  it('collapses trailing whitespace on existing content to a single space', () => {
    expect(appendSlashToken('summarize this   ', 'daily-brief')).toBe('summarize this /daily-brief ')
    expect(appendSlashToken('summarize this\n\n', 'daily-brief')).toBe('summarize this /daily-brief ')
  })

  it('appends correctly across newlines', () => {
    expect(appendSlashToken('first line\nsecond line', 'daily-brief')).toBe('first line\nsecond line /daily-brief ')
  })

  it('treats a different slug at the end as a normal append (no no-op confusion)', () => {
    // The last token is `/foo`, the new token is `/bar` — append.
    expect(appendSlashToken('/foo', 'bar')).toBe('/foo /bar ')
  })
})
