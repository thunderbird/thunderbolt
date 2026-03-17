import { clearAuthToken, setAuthToken } from '@/lib/auth-token'
import { getClock } from '@/testing-library'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleCredentialsInvalidIfNeeded, ThunderboltConnector } from './connector'

const authToken = 'test-auth-token'
const backendUrl = 'https://api.test'

describe('handleCredentialsInvalidIfNeeded', () => {
  let dispatched: CustomEvent[]
  const dispatch = (e: Event) => {
    dispatched.push(e as CustomEvent)
  }

  beforeEach(() => {
    dispatched = []
  })

  it('dispatches event with reason account_deleted for 410', () => {
    const result = handleCredentialsInvalidIfNeeded(410, {}, dispatch)

    expect(result).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].detail).toEqual({ reason: 'account_deleted' })
  })

  it('dispatches event with reason device_revoked for 403 + DEVICE_DISCONNECTED', () => {
    const result = handleCredentialsInvalidIfNeeded(403, { code: 'DEVICE_DISCONNECTED' }, dispatch)

    expect(result).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].detail).toEqual({ reason: 'device_revoked' })
  })

  it('dispatches event with reason device_id_taken for 409 + DEVICE_ID_TAKEN', () => {
    const result = handleCredentialsInvalidIfNeeded(409, { code: 'DEVICE_ID_TAKEN' }, dispatch)

    expect(result).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].detail).toEqual({ reason: 'device_id_taken' })
  })

  it('dispatches event with reason device_id_required for 400 + DEVICE_ID_REQUIRED', () => {
    const result = handleCredentialsInvalidIfNeeded(400, { code: 'DEVICE_ID_REQUIRED' }, dispatch)

    expect(result).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].detail).toEqual({ reason: 'device_id_required' })
  })

  it('does not dispatch and returns false for 401', () => {
    const result = handleCredentialsInvalidIfNeeded(401, {}, dispatch)

    expect(result).toBe(false)
    expect(dispatched).toHaveLength(0)
  })

  it('does not dispatch and returns false for 403 without DEVICE_DISCONNECTED', () => {
    const result = handleCredentialsInvalidIfNeeded(403, { code: 'OTHER_ERROR' }, dispatch)

    expect(result).toBe(false)
    expect(dispatched).toHaveLength(0)
  })

  it('does not dispatch and returns false for 403 with empty body', () => {
    const result = handleCredentialsInvalidIfNeeded(403, {}, dispatch)

    expect(result).toBe(false)
    expect(dispatched).toHaveLength(0)
  })

  it('does not dispatch and returns false for 400 without DEVICE_ID_REQUIRED', () => {
    const result = handleCredentialsInvalidIfNeeded(400, { code: 'INVALID_REQUEST' }, dispatch)

    expect(result).toBe(false)
    expect(dispatched).toHaveLength(0)
  })

  it('does not dispatch and returns false for 404', () => {
    const result = handleCredentialsInvalidIfNeeded(404, {}, dispatch)

    expect(result).toBe(false)
    expect(dispatched).toHaveLength(0)
  })
})

describe('ThunderboltConnector', () => {
  let fetchMock: ReturnType<typeof mock>
  let fetchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    fetchMock = mock()
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch)
    clearAuthToken()
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    clearAuthToken()
  })

  it('fetchCredentials returns null when no auth token', async () => {
    clearAuthToken()
    const connector = new ThunderboltConnector(backendUrl)

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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(tokenData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toEqual({
      endpoint: tokenData.powerSyncUrl,
      token: tokenData.token,
      expiresAt: new Date(tokenData.expiresAt),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [request] = fetchMock.mock.calls[0] as unknown as [Request]
    expect(request.url).toContain('/powersync/token')
    expect(request.method).toBe('GET')
  })

  it('fetchCredentials returns null when backend returns 410', async () => {
    setAuthToken(authToken)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    // Event dispatch behavior is verified by handleCredentialsInvalidIfNeeded tests above
  })

  it('fetchCredentials returns null when backend returns 401 (no event)', async () => {
    setAuthToken(authToken)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
  })

  it('fetchCredentials returns null on network error', async () => {
    setAuthToken(authToken)
    fetchMock.mockRejectedValue(new Error('Network error'))
    const connector = new ThunderboltConnector(backendUrl)

    const resultPromise = connector.fetchCredentials()
    await act(async () => {
      await getClock().runAllAsync()
    })
    const result = await resultPromise

    expect(result).toBeNull()
  })
})
