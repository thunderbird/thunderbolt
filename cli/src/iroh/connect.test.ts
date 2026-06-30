/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the connect-side refusal decision: distinguishing a remote rejection
 * (allowlist miss => closed before any data) from a clean empty round-trip. This
 * is what turns a silent "no bytes" into a clear non-zero-exit error.
 */

import { describe, expect, it } from 'bun:test'
import { refusalError } from './connect.ts'

describe('refusalError', () => {
  it('is null when any bytes came back, regardless of a close reason', () => {
    expect(refusalError(5, null, 'not allowlisted')).toBeNull()
    expect(refusalError(5, new Error('x'), null)).toBeNull()
  })

  it('is null on a clean empty round-trip (zero bytes, no failure, no reason)', () => {
    expect(refusalError(0, null, null)).toBeNull()
  })

  it('reports the peer close reason when zero bytes came back', () => {
    const err = refusalError(0, null, 'not allowlisted')
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain('not allowlisted')
  })

  it('reports a local pump failure message when there is no peer reason', () => {
    const err = refusalError(0, new Error('stream reset'), null)
    expect(err?.message).toContain('stream reset')
  })

  it('prefers the peer close reason over the local failure message', () => {
    const err = refusalError(0, new Error('local detail'), 'remote said no')
    expect(err?.message).toContain('remote said no')
    expect(err?.message).not.toContain('local detail')
  })

  it('stringifies a non-Error failure', () => {
    const err = refusalError(0, 'plain string failure', null)
    expect(err?.message).toContain('plain string failure')
  })
})
