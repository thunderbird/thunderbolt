/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { appendSlashToken } from './compose-chat-input'
import { chipMarker as m } from './parse-skill-tokens'

describe('appendSlashToken', () => {
  it('returns just the token (plus trailing space) for an empty input', () => {
    expect(appendSlashToken('', 'daily-brief')).toBe(`${m}daily-brief `)
  })

  it('returns the same input when the last token already matches the slug (clicking the same chip twice)', () => {
    expect(appendSlashToken(`${m}daily-brief `, 'daily-brief')).toBe(`${m}daily-brief `)
    expect(appendSlashToken(`${m}daily-brief`, 'daily-brief')).toBe(`${m}daily-brief `)
    expect(appendSlashToken(`hi ${m}daily-brief `, 'daily-brief')).toBe(`hi ${m}daily-brief `)
    expect(appendSlashToken(`hi ${m}daily-brief`, 'daily-brief')).toBe(`hi ${m}daily-brief `)
  })

  it('does NOT keep appending when the user alternates between two chips and the last one is repeated', () => {
    // Click daily-brief, then important-emails, then important-emails again.
    let v = ''
    v = appendSlashToken(v, 'daily-brief')
    v = appendSlashToken(v, 'important-emails')
    v = appendSlashToken(v, 'important-emails')
    expect(v).toBe(`${m}daily-brief ${m}important-emails `)
  })

  it('appends the token with a single space when the last token differs', () => {
    expect(appendSlashToken(`${m}daily-brief `, 'important-emails')).toBe(`${m}daily-brief ${m}important-emails `)
    expect(appendSlashToken('summarize this', 'daily-brief')).toBe(`summarize this ${m}daily-brief `)
  })

  it('collapses trailing whitespace on existing content to a single space', () => {
    expect(appendSlashToken('summarize this   ', 'daily-brief')).toBe(`summarize this ${m}daily-brief `)
    expect(appendSlashToken('summarize this\n\n', 'daily-brief')).toBe(`summarize this ${m}daily-brief `)
  })

  it('appends correctly across newlines', () => {
    expect(appendSlashToken('first line\nsecond line', 'daily-brief')).toBe(`first line\nsecond line ${m}daily-brief `)
  })

  it('treats a different slug at the end as a normal append (no no-op confusion)', () => {
    // The last token is `/foo`, the new token is `/bar` — append.
    expect(appendSlashToken(`${m}foo`, 'bar')).toBe(`${m}foo ${m}bar `)
  })

  it('handles multi-word display titles as a single token', () => {
    expect(appendSlashToken('', 'Daily Brief')).toBe(`${m}Daily Brief `)
    expect(appendSlashToken('hi there', 'Daily Brief')).toBe(`hi there ${m}Daily Brief `)
  })

  it('is a no-op when the input already ends with the multi-word display token', () => {
    expect(appendSlashToken(`${m}Daily Brief `, 'Daily Brief')).toBe(`${m}Daily Brief `)
    expect(appendSlashToken(`hi ${m}Daily Brief`, 'Daily Brief')).toBe(`hi ${m}Daily Brief `)
  })

  it('requires a token boundary — a mid-word slash suffix is not the token', () => {
    // "prefix/name" ends with "/name" but the `/` is glued to "prefix", so
    // this is prose containing a path, not an existing token — append.
    expect(appendSlashToken('prefix/name', 'name')).toBe(`prefix/name ${m}name `)
  })

  it('treats a literal-slash token at the end as the same chip', () => {
    expect(appendSlashToken('/Daily Brief ', 'Daily Brief')).toBe('/Daily Brief ')
    expect(appendSlashToken('hi /Daily Brief', 'Daily Brief')).toBe('hi /Daily Brief ')
  })
})
