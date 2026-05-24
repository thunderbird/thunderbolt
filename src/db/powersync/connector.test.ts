/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearAuthToken, clearDeviceId, setAuthToken } from '@/lib/auth-token'
import { getClock } from '@/testing-library'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleCredentialsInvalidIfNeeded, powersyncCredentialsInvalid, ThunderboltConnector } from './connector'

const authToken = 'test-auth-token'
const backendUrl = 'https://api.test'

describe('handleCredentialsInvalidIfNeeded', () => {
  let dispatchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    dispatchSpy = spyOn(window, 'dispatchEvent').mockImplementation(() => true)
  })

  afterEach(() => {
    dispatchSpy.mockRestore()
  })

  it('dispatches event with reason account_deleted for 410', () => {
    const result = handleCredentialsInvalidIfNeeded(410, {})

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'account_deleted' } }),
    )
  })

  it('dispatches event with reason device_revoked for 403 + DEVICE_DISCONNECTED', () => {
    const result = handleCredentialsInvalidIfNeeded(403, { code: 'DEVICE_DISCONNECTED' })

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'device_revoked' } }),
    )
  })

  it('dispatches event with reason device_id_taken for 409 + DEVICE_ID_TAKEN', () => {
    const result = handleCredentialsInvalidIfNeeded(409, { code: 'DEVICE_ID_TAKEN' })

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'device_id_taken' } }),
    )
  })

  it('dispatches event with reason device_id_required for 400 + DEVICE_ID_REQUIRED', () => {
    const result = handleCredentialsInvalidIfNeeded(400, { code: 'DEVICE_ID_REQUIRED' })

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'device_id_required' } }),
    )
  })

  it('dispatches event with reason session_expired for 401', () => {
    const result = handleCredentialsInvalidIfNeeded(401, {})

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'session_expired' } }),
    )
  })

  it('dispatches event with reason sync_not_permitted for 403 + ANONYMOUS_SYNC_FORBIDDEN', () => {
    const result = handleCredentialsInvalidIfNeeded(403, { code: 'ANONYMOUS_SYNC_FORBIDDEN' })

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'sync_not_permitted' } }),
    )
  })

  it('does not dispatch and returns false for 403 with an unknown code', () => {
    const result = handleCredentialsInvalidIfNeeded(403, { code: 'somethingElse' })

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('does not dispatch and returns false for 403 without DEVICE_DISCONNECTED', () => {
    const result = handleCredentialsInvalidIfNeeded(403, { code: 'OTHER_ERROR' })

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('does not dispatch and returns false for 403 with empty body', () => {
    const result = handleCredentialsInvalidIfNeeded(403, {})

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('does not dispatch and returns false for 400 without DEVICE_ID_REQUIRED', () => {
    const result = handleCredentialsInvalidIfNeeded(400, { code: 'INVALID_REQUEST' })

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('does not dispatch and returns false for 404', () => {
    const result = handleCredentialsInvalidIfNeeded(404, {})

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})

describe('ThunderboltConnector', () => {
  let savedAuthMode: string | undefined
  let fetchMock: ReturnType<typeof mock>
  let dispatchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    savedAuthMode = import.meta.env.VITE_AUTH_MODE
    // Default to consumer mode so tests don't depend on local .env
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = undefined
    fetchMock = mock()
    dispatchSpy = spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    clearAuthToken()
    clearDeviceId()
  })

  afterEach(() => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
    dispatchSpy.mockRestore()
  })

  it('fetchCredentials returns null when no auth token', async () => {
    clearAuthToken()
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetchCredentials returns credentials when backend returns 200', async () => {
    setAuthToken(authToken)
    const tokenData = {
      token: 'ps-token',
      expiresAt: '2025-12-31T00:00:00Z',
      powerSyncUrl: 'wss://ps.test/sync',
    }
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(tokenData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const result = await connector.fetchCredentials()

    expect(result).toEqual({
      endpoint: tokenData.powerSyncUrl,
      token: tokenData.token,
      expiresAt: new Date(tokenData.expiresAt),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/powersync/token')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${authToken}`)
    expect(headers['X-Device-ID']).toBeTruthy()
    expect(headers['X-Device-Name']).toBeTruthy()
  })

  it('fetchCredentials returns null and dispatches event when backend returns 410', async () => {
    setAuthToken(authToken)
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 410,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'account_deleted' } }),
    )
  })

  it('fetchCredentials returns null and dispatches session_expired when backend returns 401', async () => {
    setAuthToken(authToken)
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'session_expired' } }),
    )
  })

  it('fetchCredentials returns null on network error', async () => {
    setAuthToken(authToken)
    fetchMock.mockImplementation(() => Promise.reject(new Error('Network error')))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const resultPromise = connector.fetchCredentials()
    await act(async () => {
      await getClock().runAllAsync()
    })
    const result = await resultPromise

    expect(result).toBeNull()
  })

  it('fetchCredentials returns null and dispatches sync_not_permitted for 403 + ANONYMOUS_SYNC_FORBIDDEN', async () => {
    setAuthToken(authToken)
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Forbidden', code: 'ANONYMOUS_SYNC_FORBIDDEN' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'sync_not_permitted' } }),
    )
  })

  it('fetchCredentials does not log to console.error for the quiet ANONYMOUS_SYNC_FORBIDDEN 403', async () => {
    setAuthToken(authToken)
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Forbidden', code: 'ANONYMOUS_SYNC_FORBIDDEN' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      )
      const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

      const result = await connector.fetchCredentials()

      expect(result).toBeNull()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
