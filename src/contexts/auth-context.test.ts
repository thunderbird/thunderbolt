/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { testServerId } from '@/testing-library'
import { buildFetchOptions } from './auth-context'

const authTokenKey = `thunderbolt_auth_token__${testServerId}`

const fireStorageEvent = (newValue: string | null, oldValue: string | null) => {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: authTokenKey,
      newValue,
      oldValue,
      storageArea: localStorage,
    }),
  )
}

const originalDispatch = window.dispatchEvent

describe('buildFetchOptions onError', () => {
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
    clearAuthToken()
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
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

describe('AuthProvider — cross-tab auth-token listener', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  let reloadSpy: ReturnType<typeof mock>
  let capturedEvents: CustomEvent[] = []
  const originalReload = window.location.reload

  const handleCapturedEvent = (e: Event) => {
    capturedEvents.push(e as CustomEvent)
  }

  beforeEach(() => {
    capturedEvents = []
    reloadSpy = mock(() => {})
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: reloadSpy,
    })
    window.addEventListener(powersyncCredentialsInvalid, handleCapturedEvent)
    clearAuthToken()
  })

  afterEach(() => {
    window.removeEventListener(powersyncCredentialsInvalid, handleCapturedEvent)
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      value: originalReload,
    })
    cleanup()
    clearAuthToken()
  })

  const renderAuthProvider = () => {
    const authClient = createMockAuthClient({ session: null })
    const TestProvider = createTestProvider({ authClient })
    return render(null, { wrapper: TestProvider })
  }

  it('reloads when another tab rotates the token (newValue truthy and different)', () => {
    renderAuthProvider()

    fireStorageEvent('new-token', 'old-token')

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(capturedEvents).toHaveLength(0)
  })

  it('dispatches session_expired when another tab clears the token', () => {
    renderAuthProvider()

    fireStorageEvent(null, 'old-token')

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(capturedEvents).toHaveLength(1)
    expect(capturedEvents[0].type).toBe(powersyncCredentialsInvalid)
    expect(capturedEvents[0].detail).toEqual({ reason: 'session_expired' })
  })
})
