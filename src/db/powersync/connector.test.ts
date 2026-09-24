/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { clearAuthToken, clearDeviceId, setAuthToken } from '@/lib/auth-token'
import { getClock } from '@/testing-library'
import { clearAllKeys, generateAK, getPrimaryKeyId, storeAK, storePrimaryKeyId } from '@/crypto'
import { resetCodecState } from '@/db/encryption'
import type { AbstractPowerSyncDatabase } from '@powersync/web'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleCredentialsInvalidIfNeeded, powersyncCredentialsInvalid, ThunderboltConnector } from './connector'

const authToken = 'test-auth-token'
const backendUrl = 'https://api.test/v1'

const createFetchStub = (fetchMock: ReturnType<typeof mock>): typeof fetch =>
  Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init), {
    preconnect: globalThis.fetch.preconnect,
  })

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

  beforeEach(async () => {
    savedAuthMode = import.meta.env.VITE_AUTH_MODE
    // Default to consumer mode so tests don't depend on local .env
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = undefined
    fetchMock = mock()
    dispatchSpy = spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    clearAuthToken()
    clearDeviceId()
    // These tests exercise the token endpoint's HTTP handling; stage an AK so
    // the download encryption gate short-circuits instead of probing the canary
    // (the gate itself is covered by the dedicated suites below).
    await clearAllKeys()
    await storeAK(await generateAK())
  })

  afterEach(async () => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
    dispatchSpy.mockRestore()
    // Clear the auth token/device id so the last test's value can't leak into
    // the next test file and trigger AuthProvider's mount get-session call.
    clearAuthToken()
    clearDeviceId()
    await clearAllKeys()
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

  for (const connectorUrl of [backendUrl, `${backendUrl}/`]) {
    it(`fetchCredentials uses the exact token endpoint for ${connectorUrl}`, async () => {
      setAuthToken(authToken)
      fetchMock.mockResolvedValue(
        Response.json({
          token: 'ps-token',
          expiresAt: '2025-12-31T00:00:00Z',
          powerSyncUrl: 'wss://ps.test/sync',
        }),
      )
      const connector = new ThunderboltConnector(connectorUrl, createFetchStub(fetchMock))

      await connector.fetchCredentials()

      const url = fetchMock.mock.calls[0]?.[0]
      expect(url).toBe('https://api.test/v1/powersync/token')
      expect(url).not.toContain('/v1//')
    })

    it(`uploadData uses the exact upload endpoint for ${connectorUrl}`, async () => {
      // A verified primary key_id lets the v2 upload gate proceed; without it
      // uploadData defers (throws) before reaching the endpoint under test.
      await storePrimaryKeyId('0')
      const complete = mock(() => Promise.resolve())
      const database = Object.create(null) as AbstractPowerSyncDatabase
      database.getNextCrudTransaction = async () => ({ crud: [], haveMore: false, complete })
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
      const connector = new ThunderboltConnector(connectorUrl, createFetchStub(fetchMock))

      await connector.uploadData(database)

      const url = fetchMock.mock.calls[0]?.[0]
      expect(url).toBe('https://api.test/v1/powersync/upload')
      expect(url).not.toContain('/v1//')
      expect(complete).toHaveBeenCalledTimes(1)
    })
  }

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
  })

  afterEach(async () => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
    await clearAllKeys()
    clearAuthToken()
    clearDeviceId()
  })

  it('never adopts the metadata pointer — defers and nudges an envelope adoption (THU-890)', async () => {
    // This used to store `metadata.primary_key_id`, which made the connector
    // the door for a grammar-valid pointer rollback ('0' served after a
    // rotation moved the primary to '1'). The pointer's only trusted source is
    // now the AK envelope: the connector defers the batch and posts a
    // key-request so the main-thread responder re-adopts.
    await storeAK(await generateAK())
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/encryption/canary') ? okResponse({ primary_key_id: '0' }) : okResponse({})),
    )
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    // Spy on the channel's post rather than listening: delivery is async and
    // this suite runs under a controlled clock, so a listener would race.
    const nudges: unknown[] = []
    const postSpy = spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (
      this: BroadcastChannel,
      message: unknown,
    ) {
      nudges.push(message)
    })
    try {
      await expect(connector.uploadData(makeDatabase())).rejects.toThrow(/deferring upload until the envelope/)
    } finally {
      postSpy.mockRestore()
    }

    expect(await getPrimaryKeyId()).toBeNull()
    expect(requestedUrls().some((url) => url.includes('/powersync/upload'))).toBe(false)
    expect(nudges).toContainEqual({ type: 'key-request', keyId: '0', reason: 'unknown-key' })
  })

  it('does not fetch metadata when a primary key_id is already loaded', async () => {
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
  })

  afterEach(async () => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
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

  it('defers the upload whatever pointer the server serves — "v1" steer included (THU-876/THU-890)', async () => {
    // This used to be the second place a served pointer became durable local
    // state. Post-THU-890 the connector never reads the metadata pointer at
    // all: honest, steered ('v1') or rolled back ('0'), the answer is the same
    // defer until an adopted envelope supplies the pointer.
    await storeAK(await generateAK())
    fetchMock = routeCanary(() => jsonResponse({ primary_key_id: 'v1' }))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
    const { database, wasCompleted } = makeDatabase()

    await expect(connector.uploadData(database)).rejects.toThrow(/deferring upload until the envelope/)

    expect(uploadAttempted()).toBe(false)
    expect(wasCompleted()).toBe(false)
    // Nothing durable was written, so a later honest adoption still lands.
    expect(await getPrimaryKeyId()).toBeNull()
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

  it('defers the upload AND surfaces session_expired when the probe is rejected with 401', async () => {
    // The upload gate shares the probe, and it too runs before any authed
    // request that would otherwise report the dead session.
    const dispatchSpy = spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    try {
      fetchMock = routeCanary(() => jsonResponse({ error: 'Unauthorized' }, 401))
      const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)
      const { database, wasCompleted } = makeDatabase()

      await expect(connector.uploadData(database)).rejects.toThrow(/Cannot confirm account encryption state/)

      expect(uploadAttempted()).toBe(false)
      expect(wasCompleted()).toBe(false)
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'session_expired' } }),
      )
    } finally {
      dispatchSpy.mockRestore()
    }
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
})

describe('ThunderboltConnector download encryption gate', () => {
  let savedAuthMode: string | undefined
  let fetchMock: ReturnType<typeof mock>
  let dispatchSpy: ReturnType<typeof spyOn>

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const tokenResponse = () =>
    jsonResponse({ token: 'ps-token', expiresAt: '2099-12-31T00:00:00Z', powerSyncUrl: 'wss://ps.test/sync' })

  /** Route `/encryption/canary` to `canary`; the token endpoint always succeeds. */
  const routeCanary = (canary: () => Response | Promise<Response>) =>
    mock((url: string) =>
      url.includes('/encryption/canary') ? Promise.resolve(canary()) : Promise.resolve(tokenResponse()),
    )

  const requestedUrls = (): string[] => fetchMock.mock.calls.map((call) => call[0] as string)
  const tokenRequested = (): boolean => requestedUrls().some((url) => url.includes('/powersync/token'))
  const canaryRequested = (): boolean => requestedUrls().some((url) => url.includes('/encryption/canary'))
  const invalidReasons = (): string[] =>
    (dispatchSpy.mock.calls as [Event][])
      .map(([event]) => event)
      .filter((event): event is CustomEvent<{ reason: string }> => event.type === powersyncCredentialsInvalid)
      .map((event) => event.detail.reason)

  beforeEach(async () => {
    savedAuthMode = import.meta.env.VITE_AUTH_MODE
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = undefined
    setAuthToken(authToken)
    dispatchSpy = spyOn(window, 'dispatchEvent').mockImplementation(() => true)
    await clearAllKeys()
    resetCodecState()
  })

  afterEach(async () => {
    ;(import.meta.env as Record<string, unknown>).VITE_AUTH_MODE = savedAuthMode
    dispatchSpy.mockRestore()
    await clearAllKeys()
    resetCodecState()
    clearAuthToken()
    clearDeviceId()
  })

  it('withholds credentials when the account is encrypted but this device has no keyring', async () => {
    // A v1-trusted device on an already-migrated account: syncing would persist
    // raw ciphertext into local SQLite via the codec's passthrough.
    fetchMock = routeCanary(() => jsonResponse({ primary_key_id: '0' }))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    expect(await connector.fetchCredentials()).toBeNull()
    expect(tokenRequested()).toBe(false)
    // A set-up account is a healthy answer, not a credentials problem.
    expect(invalidReasons()).toEqual([])
  })

  it('issues credentials once an AK is present, without probing', async () => {
    await storeAK(await generateAK())
    fetchMock = routeCanary(() => jsonResponse({ primary_key_id: '0' }))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const credentials = await connector.fetchCredentials()

    expect(credentials?.token).toBe('ps-token')
    expect(requestedUrls().some((url) => url.includes('/encryption/canary'))).toBe(false)
  })

  it('issues credentials for an account that never enabled E2EE', async () => {
    fetchMock = routeCanary(() => jsonResponse({ error: 'Encryption not set up' }, 404))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const credentials = await connector.fetchCredentials()

    expect(credentials?.token).toBe('ps-token')
    expect(canaryRequested()).toBe(true)
    expect(invalidReasons()).toEqual([])
  })

  it('withholds credentials when the encryption probe fails', async () => {
    // An unprovable state must not be read as "nothing to decrypt".
    fetchMock = routeCanary(() => jsonResponse({ error: 'boom' }, 500))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    expect(await connector.fetchCredentials()).toBeNull()
    expect(tokenRequested()).toBe(false)
    // A 5xx says nothing about the session — inventing a reason here would pop
    // the sign-in modal on every backend hiccup.
    expect(invalidReasons()).toEqual([])
  })

  it('withholds credentials without invalidating when the probe cannot reach the backend', async () => {
    fetchMock = routeCanary(() => {
      throw new Error('network down')
    })
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    expect(await connector.fetchCredentials()).toBeNull()
    expect(tokenRequested()).toBe(false)
    expect(invalidReasons()).toEqual([])
  })

  it('surfaces session_expired when the probe is rejected with 401', async () => {
    // The gate short-circuits before `/powersync/token`, so the canary is the
    // ONLY request a keyless device makes. Without routing its rejection to
    // `handleCredentialsInvalidIfNeeded` the auth failure is invisible: no
    // sign-in modal, and the device retries a dead session forever.
    fetchMock = routeCanary(() => jsonResponse({ error: 'Unauthorized' }, 401))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    expect(await connector.fetchCredentials()).toBeNull()
    expect(tokenRequested()).toBe(false)
    expect(invalidReasons()).toEqual(['session_expired'])
  })

  it('surfaces device_revoked when the probe is rejected with 403 + DEVICE_DISCONNECTED', async () => {
    fetchMock = routeCanary(() => jsonResponse({ code: 'DEVICE_DISCONNECTED' }, 403))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    expect(await connector.fetchCredentials()).toBeNull()
    expect(tokenRequested()).toBe(false)
    expect(invalidReasons()).toEqual(['device_revoked'])
  })

  it('withholds without invalidating for an uncoded 403', async () => {
    // A bare 403 proves nothing about the session (a gateway, a WAF, a route
    // guard we do not model), so it stays an unprovable `unknown` — withheld,
    // but no modal. Only the coded 403s are an authorization verdict.
    fetchMock = routeCanary(() => jsonResponse({ error: 'Forbidden' }, 403))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    expect(await connector.fetchCredentials()).toBeNull()
    expect(tokenRequested()).toBe(false)
    expect(invalidReasons()).toEqual([])
  })

  it('does not probe at all when an AK is present, so a canary 401 cannot fire', async () => {
    await storeAK(await generateAK())
    fetchMock = routeCanary(() => jsonResponse({ error: 'Unauthorized' }, 401))
    const connector = new ThunderboltConnector(backendUrl, fetchMock as unknown as typeof fetch)

    const credentials = await connector.fetchCredentials()

    expect(credentials?.token).toBe('ps-token')
    expect(canaryRequested()).toBe(false)
    expect(invalidReasons()).toEqual([])
  })
})
