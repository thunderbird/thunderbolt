/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { clearAuthToken, clearDeviceId, setAuthToken } from '@/lib/auth-token'
import { getClock } from '@/testing-library'
import { useConfigStore } from '@/api/config-store'
import { clearAllKeys, generateAK, getPrimaryKeyId, storeAK, storePrimaryKeyId } from '@/crypto'
import { resetCodecState } from '@/db/encryption'
import type { AbstractPowerSyncDatabase } from '@powersync/web'
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
    // Clear the auth token/device id so the last test's value can't leak into
    // the next test file and trigger AuthProvider's mount get-session call.
    clearAuthToken()
    clearDeviceId()
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
      // Assert only the credentials-fetch log is suppressed, not "no console.error
      // anywhere". The connector also calls trackSyncEvent → trackEvent, whose catch
      // block logs if posthogClient.capture() throws. posthogClient is a module-level
      // singleton in lib/posthog.tsx that other test files (notably posthog.test.ts,
      // which does mock.module('posthog-js') + initPosthog) leave initialized — under
      // --randomize, that leaked client can throw during this test. Fixing the
      // singleton properly is a follow-up; the scoped assertion is what the test name
      // promises.
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch PowerSync credentials'),
        expect.anything(),
        expect.anything(),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('ThunderboltConnector primary-key load (TD3)', () => {
  let savedAuthMode: string | undefined
  let fetchMock: ReturnType<typeof mock>

  // A DELETE op keeps `encodeForUpload` a no-op, so uploadData exercises only the
  // primary-key-load path we're testing (encryption of a real column is Track C's concern).
  const makeDatabase = (): AbstractPowerSyncDatabase =>
    ({
      getNextCrudTransaction: async () => ({
        crud: [{ op: 'DELETE', table: 'tasks', id: 'row-1', opData: null }],
        complete: async () => {},
      }),
    }) as unknown as AbstractPowerSyncDatabase

  const okResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const requestedUrls = (): string[] => fetchMock.mock.calls.map((call) => call[0] as string)

  beforeEach(async () => {
    savedAuthMode = import.meta.env.VITE_AUTH_MODE
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = undefined
    setAuthToken(authToken)
    fetchMock = mock(() => Promise.resolve(okResponse({})))
    await clearAllKeys()
    useConfigStore.getState().updateConfig({})
  })

  afterEach(async () => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
    useConfigStore.getState().updateConfig({})
    await clearAllKeys()
    clearAuthToken()
    clearDeviceId()
  })

  it('fetches metadata and stores the primary key_id when E2EE is on, an AK exists, and none is loaded', async () => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
    await storeAK(await generateAK())
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/encryption/canary') ? okResponse({ primary_key_id: '0' }) : okResponse({})),
    )
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    await connector.uploadData(makeDatabase())

    expect(await getPrimaryKeyId()).toBe('0')
    expect(requestedUrls().some((url) => url.includes('/encryption/canary'))).toBe(true)
    expect(requestedUrls().some((url) => url.includes('/powersync/upload'))).toBe(true)
  })

  it('does not fetch metadata when E2EE is disabled', async () => {
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    await connector.uploadData(makeDatabase())

    expect(requestedUrls().some((url) => url.includes('/encryption/canary'))).toBe(false)
    expect(requestedUrls().some((url) => url.includes('/powersync/upload'))).toBe(true)
  })

  it('does not fetch metadata when a primary key_id is already loaded', async () => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
    await storeAK(await generateAK())
    await storePrimaryKeyId('3')
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    await connector.uploadData(makeDatabase())

    expect(requestedUrls().some((url) => url.includes('/encryption/canary'))).toBe(false)
    expect(await getPrimaryKeyId()).toBe('3')
  })
})

describe('ThunderboltConnector upload encryption gate', () => {
  let savedAuthMode: string | undefined
  let fetchMock: ReturnType<typeof mock>

  /** A PATCH on an encrypted column (`tasks.item`) — the payload that must never
   *  reach the server as plaintext once the account is encrypted. */
  const makeDatabase = () => {
    let completed = false
    const database = {
      getNextCrudTransaction: async () => ({
        crud: [{ op: 'PATCH', table: 'tasks', id: 'row-1', opData: { item: 'buy milk' } }],
        complete: async () => {
          completed = true
        },
      }),
    } as unknown as AbstractPowerSyncDatabase
    return { database, wasCompleted: () => completed }
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  /** Route `/encryption/canary` to `canary`; everything else succeeds. */
  const routeCanary = (canary: () => Response | Promise<Response>) =>
    mock((url: string) =>
      url.includes('/encryption/canary') ? Promise.resolve(canary()) : Promise.resolve(jsonResponse({})),
    )

  const requestedUrls = (): string[] => fetchMock.mock.calls.map((call) => call[0] as string)
  const uploadAttempted = (): boolean => requestedUrls().some((url) => url.includes('/powersync/upload'))

  beforeEach(async () => {
    savedAuthMode = import.meta.env.VITE_AUTH_MODE
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = undefined
    setAuthToken(authToken)
    await clearAllKeys()
    resetCodecState()
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
  })

  afterEach(async () => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
    useConfigStore.getState().updateConfig({})
    await clearAllKeys()
    resetCodecState()
    clearAuthToken()
    clearDeviceId()
  })

  it('refuses to upload when the account is encrypted but this device has no access key', async () => {
    // The regression: a stale client's queued writes flushing after an upgrade,
    // before the keyring reaches this device. Must defer, never upload plaintext.
    fetchMock = routeCanary(() => jsonResponse({ primary_key_id: '0' }))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
    const { database, wasCompleted } = makeDatabase()

    await expect(connector.uploadData(database)).rejects.toThrow(/no access key/)

    expect(uploadAttempted()).toBe(false)
    // Not completing the transaction is what preserves the writes for a retry.
    expect(wasCompleted()).toBe(false)
  })

  it('uploads plaintext for an account that never enabled E2EE (404)', async () => {
    fetchMock = routeCanary(() => jsonResponse({ error: 'Encryption not set up' }, 404))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
    const { database, wasCompleted } = makeDatabase()

    await connector.uploadData(database)

    expect(uploadAttempted()).toBe(true)
    expect(wasCompleted()).toBe(true)
    const uploadCall = fetchMock.mock.calls.find((call) => (call[0] as string).includes('/powersync/upload'))
    expect((uploadCall?.[1] as RequestInit).body).toContain('buy milk')
  })

  it('defers the upload when the encryption probe fails', async () => {
    fetchMock = routeCanary(() => jsonResponse({ error: 'boom' }, 500))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
    const { database, wasCompleted } = makeDatabase()

    await expect(connector.uploadData(database)).rejects.toThrow(/Cannot confirm account encryption state/)

    expect(uploadAttempted()).toBe(false)
    expect(wasCompleted()).toBe(false)
  })

  it('defers the upload when the encryption probe cannot reach the backend', async () => {
    // Offline must not be read as "account not encrypted".
    fetchMock = routeCanary(() => {
      throw new Error('network down')
    })
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
    const { database, wasCompleted } = makeDatabase()

    await expect(connector.uploadData(database)).rejects.toThrow(/Cannot confirm account encryption state/)

    expect(uploadAttempted()).toBe(false)
    expect(wasCompleted()).toBe(false)
  })

  it('does not probe at all when E2EE is disabled for the deployment', async () => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: false })
    fetchMock = routeCanary(() => jsonResponse({ primary_key_id: '0' }))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
    const { database, wasCompleted } = makeDatabase()

    await connector.uploadData(database)

    expect(requestedUrls().some((url) => url.includes('/encryption/canary'))).toBe(false)
    expect(wasCompleted()).toBe(true)
  })
})
