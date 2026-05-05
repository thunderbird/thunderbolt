/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { buildFetchOptions } from './auth-context'

describe('buildFetchOptions onError', () => {
  let dispatchSpy: ReturnType<typeof mock>
  let savedDispatch: typeof window.dispatchEvent

  beforeEach(() => {
    savedDispatch = window.dispatchEvent
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
    clearAuthToken()
  })

  afterEach(() => {
    window.dispatchEvent = savedDispatch
    clearAuthToken()
  })

  const trigger401 = () => {
    const options = buildFetchOptions('web')
    options.onError({ response: new Response(null, { status: 401 }) })
  }

  it('dispatches session_expired when a stored token is rejected with 401', () => {
    setAuthToken('stale-token')

    trigger401()

    expect(getAuthToken()).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('powersync_credentials_invalid')
    expect(event.detail).toEqual({ reason: 'session_expired' })
  })

  it('does not dispatch on 401 when no token was stored (e.g. wrong OTP at sign-in)', () => {
    expect(getAuthToken()).toBeNull()

    trigger401()

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('does not dispatch on non-401 responses', () => {
    setAuthToken('valid-token')
    const options = buildFetchOptions('web')

    options.onError({ response: new Response(null, { status: 500 }) })

    expect(getAuthToken()).toBe('valid-token')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})
