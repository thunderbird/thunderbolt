/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { clearAuthToken, clearDeviceId, setAuthToken } from '@/lib/auth-token'
import { useConfigStore } from '@/api/config-store'
import { generateAK, mintDEK } from '@/crypto/primitives'
import { getPrimaryKeyId, storeAK, storePrimaryKeyId, storeWrappedDEK } from '@/crypto/key-storage'
import { codec, invalidateKeyCache, resetCodecState, setKeysSyncChannelForTesting } from '@/db/encryption/codec'
import { getClock } from '@/testing-library'
import { act } from '@testing-library/react'
import type { AbstractPowerSyncDatabase } from '@powersync/web'
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

describe('uploadData primary-key load (D3)', () => {
  const deleteKeysDatabase = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('thunderbolt-keys')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })

  type UploadBody = { operations: Array<{ data?: Record<string, unknown> }> }

  /**
   * Routed fetch fake serving the two endpoints uploadData touches: the
   * encryption metadata (D3 primary-key load) and the upload itself. Captures
   * upload bodies and counts metadata hits.
   */
  const createRoutedFetch = (metadata: Record<string, unknown>) => {
    const uploadBodies: UploadBody[] = []
    const canaryUrls: string[] = []
    const fetchFn = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/encryption/canary')) {
        canaryUrls.push(url)
        return Promise.resolve(
          new Response(JSON.stringify(metadata), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        )
      }
      if (url.includes('/powersync/upload')) {
        uploadBodies.push(JSON.parse(String(init?.body)) as UploadBody)
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    return { fetchFn: fetchFn as unknown as typeof fetch, uploadBodies, canaryUrls }
  }

  const makeDatabase = (opData: Record<string, unknown>) => {
    const transaction = {
      crud: [{ op: 'PUT', table: 'tasks', id: 'row-1', opData }],
      complete: mock(() => Promise.resolve()),
    }
    return {
      database: { getNextCrudTransaction: async () => transaction } as unknown as AbstractPowerSyncDatabase,
      transaction,
    }
  }

  beforeEach(async () => {
    await deleteKeysDatabase()
    // Isolate the codec from real/leaked BroadcastChannels; encode never posts
    // key-requests, so an inert channel is enough.
    setKeysSyncChannelForTesting({ postMessage: () => {}, onMessage: () => {} })
    resetCodecState()
    useConfigStore.setState({ config: { e2eeEnabled: true } })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('loads the primary key_id from metadata before encoding when the local pointer is missing', async () => {
    // Setup-complete device (AK present, DEK '1' staged) whose primary-key
    // pointer is missing — without the D3 load, encode would find no primary
    // (there is no DEK '0' fallback either) and fail open to plaintext.
    const ak = await generateAK()
    await storeAK(ak)
    const minted = await mintDEK(ak)
    await storeWrappedDEK('1', minted.wrappedKey)

    const { fetchFn, uploadBodies, canaryUrls } = createRoutedFetch({ primary_key_id: '1', key_version: 1 })
    const connector = new ThunderboltConnector(backendUrl, fetchFn)
    const { database, transaction } = makeDatabase({ item: 'secret task' })

    await connector.uploadData(database)

    expect(canaryUrls).toHaveLength(1)
    expect(await getPrimaryKeyId()).toBe('1')
    const item = uploadBodies[0]?.operations[0]?.data?.item as string
    expect(item.startsWith('__enc:v2:1:')).toBe(true)
    expect(await codec.decode(item, { table: 'tasks', column: 'item', rowId: 'row-1' })).toBe('secret task')
    expect(transaction.complete).toHaveBeenCalledTimes(1)
  })

  it('picks up the new primary key_id on the next batch after a DEK rotation, without a metadata fetch', async () => {
    const ak = await generateAK()
    await storeAK(ak)
    const minted0 = await mintDEK(ak)
    await storeWrappedDEK('0', minted0.wrappedKey)
    await storePrimaryKeyId('0')

    const { fetchFn, uploadBodies, canaryUrls } = createRoutedFetch({ primary_key_id: '0', key_version: 1 })
    const connector = new ThunderboltConnector(backendUrl, fetchFn)

    const first = makeDatabase({ item: 'before rotation' })
    await connector.uploadData(first.database)
    const firstItem = uploadBodies[0]?.operations[0]?.data?.item as string
    expect(firstItem.startsWith('__enc:v2:0:')).toBe(true)

    // Local DEK rotation (rotateDEK): stage the new key, move the pointer,
    // broadcast invalidate so the codec drops its cached primary.
    const minted1 = await mintDEK(ak)
    await storeWrappedDEK('1', minted1.wrappedKey)
    await storePrimaryKeyId('1')
    invalidateKeyCache()

    const second = makeDatabase({ item: 'after rotation' })
    await connector.uploadData(second.database)
    const secondItem = uploadBodies[1]?.operations[0]?.data?.item as string
    expect(secondItem.startsWith('__enc:v2:1:')).toBe(true)

    // The pointer was present both times — the light metadata fetch never fired.
    expect(canaryUrls).toHaveLength(0)
  })

  it('skips the metadata fetch when setup is incomplete (no AK) and uploads fail-open plaintext', async () => {
    const { fetchFn, uploadBodies, canaryUrls } = createRoutedFetch({ primary_key_id: '0', key_version: 1 })
    const connector = new ThunderboltConnector(backendUrl, fetchFn)
    const { database } = makeDatabase({ item: 'pre-setup' })

    await connector.uploadData(database)

    expect(canaryUrls).toHaveLength(0)
    expect(uploadBodies[0]?.operations[0]?.data?.item).toBe('pre-setup')
  })

  it('skips the metadata fetch entirely when encryption is disabled', async () => {
    useConfigStore.setState({ config: {} })
    const { fetchFn, uploadBodies, canaryUrls } = createRoutedFetch({ primary_key_id: '0', key_version: 1 })
    const connector = new ThunderboltConnector(backendUrl, fetchFn)
    const { database, transaction } = makeDatabase({ item: 'plain' })

    await connector.uploadData(database)

    expect(canaryUrls).toHaveLength(0)
    expect(uploadBodies[0]?.operations[0]?.data?.item).toBe('plain')
    expect(transaction.complete).toHaveBeenCalledTimes(1)
  })
})
