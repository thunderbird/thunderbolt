/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getSlashState } from './use-slash-command'

describe('getSlashState', () => {
  it('returns null when the caret is outside the value bounds', () => {
    expect(getSlashState('hello', -1)).toBeNull()
    expect(getSlashState('hello', 6)).toBeNull()
  })

  it('returns null when there is no in-progress slash token', () => {
    expect(getSlashState('hello world', 5)).toBeNull()
    expect(getSlashState('', 0)).toBeNull()
  })

  it('detects a slash token at the start of the input', () => {
    expect(getSlashState('/meet', 5)).toEqual({ tokenStart: 0, query: 'meet' })
  })

  it('detects a slash token after a space', () => {
    expect(getSlashState('hello /meet', 11)).toEqual({ tokenStart: 6, query: 'meet' })
  })

  it('detects a slash token after a newline', () => {
    expect(getSlashState('line one\n/meet', 14)).toEqual({ tokenStart: 9, query: 'meet' })
  })

  it('treats a lone slash with no query as a token (empty query opens the full popup)', () => {
    expect(getSlashState('hello /', 7)).toEqual({ tokenStart: 6, query: '' })
  })

  it('returns null when the would-be token does not start with /', () => {
    // caret right after "world" — the preceding chunk is "world", not a slash token.
    expect(getSlashState('hello world', 11)).toBeNull()
  })

  it('returns null when the caret is mid-word after a space-prefixed identifier', () => {
    // " meet" — no leading slash, so no token.
    expect(getSlashState('hello meet', 10)).toBeNull()
  })

  it('honors the caret position when there is text after it', () => {
    // value = "hi /meet later"; caret at index 7 (just after "mee"), so the
    // in-progress query is "mee" — the trailing "t later" is not yet typed
    // from the autocomplete state machine's perspective.
    expect(getSlashState('hi /meet later', 7)).toEqual({ tokenStart: 3, query: 'mee' })
  })
})
