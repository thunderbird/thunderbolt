/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { clearCachedSession, getCachedSession, isCachedSessionValid, setCachedSession } from './session-cache'

const sessionCacheKey = 'thunderbolt_session_cache'

afterEach(() => {
  localStorage.removeItem(sessionCacheKey)
})

describe('session-cache', () => {
  it('returns null when nothing is cached', () => {
    expect(getCachedSession()).toBeNull()
  })

  it('round-trips through localStorage', () => {
    const data = { user: { id: '1', email: 'u@example.com' }, session: { id: 's1' } }
    setCachedSession(data)
    expect(getCachedSession()).toEqual(data)
  })

  it('clearCachedSession removes the entry', () => {
    setCachedSession({ user: { id: '1' } })
    clearCachedSession()
    expect(getCachedSession()).toBeNull()
  })

  it('returns null for malformed JSON without throwing', () => {
    localStorage.setItem(sessionCacheKey, '{not-json')
    expect(getCachedSession()).toBeNull()
  })

  it('returns null when the stored value is not an object', () => {
    localStorage.setItem(sessionCacheKey, JSON.stringify('not-an-object'))
    expect(getCachedSession()).toBeNull()
  })

  it('returns null when the stored value is an array', () => {
    localStorage.setItem(sessionCacheKey, JSON.stringify([]))
    expect(getCachedSession()).toBeNull()
  })
})

describe('isCachedSessionValid', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString()
  const past = () => new Date(Date.now() - 60_000).toISOString()

  it('returns true when session.expiresAt is in the future', () => {
    expect(isCachedSessionValid({ user: { id: '1' }, session: { expiresAt: future() } })).toBe(true)
  })

  it('returns false when session.expiresAt is in the past', () => {
    expect(isCachedSessionValid({ user: { id: '1' }, session: { expiresAt: past() } })).toBe(false)
  })

  it('returns false when session.expiresAt is missing', () => {
    expect(isCachedSessionValid({ user: { id: '1' }, session: {} })).toBe(false)
  })

  it('returns false when session is missing', () => {
    expect(isCachedSessionValid({ user: { id: '1' } })).toBe(false)
  })

  it('returns false when expiresAt is not parseable', () => {
    expect(isCachedSessionValid({ user: { id: '1' }, session: { expiresAt: 'not-a-date' } })).toBe(false)
  })

  it('accepts numeric expiresAt (unix ms)', () => {
    expect(isCachedSessionValid({ user: { id: '1' }, session: { expiresAt: Date.now() + 60_000 } })).toBe(true)
  })
})
