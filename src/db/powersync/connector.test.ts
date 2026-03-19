import { clearAuthToken, setAuthToken } from '@/lib/auth-token'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { handleCredentialsInvalidIfNeeded, powersyncCredentialsInvalid, ThunderboltConnector } from './connector'

const authToken = 'test-auth-token'
const backendUrl = 'https://api.test'

/** Create a minimal ky-like response wrapper for mocking ky.get/ky.put */
const createKyResponse = (body: Record<string, unknown>, status: number) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

const kyGetMock = mock()
const kyPutMock = mock()

mock.module('ky', () => ({
  default: Object.assign(
    () => {
      throw new Error('ky default call not expected')
    },
    { get: kyGetMock, put: kyPutMock },
  ),
}))

describe('handleCredentialsInvalidIfNeeded', () => {
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    dispatchSpy = mock(() => {})
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
  })

  afterEach(() => {
    dispatchSpy.mockRestore?.()
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

  it('does not dispatch and returns false for 401', () => {
    const result = handleCredentialsInvalidIfNeeded(401, {})

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
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    dispatchSpy = mock(() => {})
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
    kyGetMock.mockReset()
    kyPutMock.mockReset()
    clearAuthToken()
  })

  it('fetchCredentials returns null when no auth token', async () => {
    clearAuthToken()
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(kyGetMock).not.toHaveBeenCalled()
  })

  it('fetchCredentials returns credentials when backend returns 200', async () => {
    setAuthToken(authToken)
    const tokenData = {
      token: 'ps-token',
      expiresAt: '2025-12-31T00:00:00Z',
      powerSyncUrl: 'wss://ps.test/sync',
    }
    kyGetMock.mockReturnValue(createKyResponse(tokenData, 200))
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toEqual({
      endpoint: tokenData.powerSyncUrl,
      token: tokenData.token,
      expiresAt: new Date(tokenData.expiresAt),
    })
    expect(kyGetMock).toHaveBeenCalledTimes(1)
    const [url] = kyGetMock.mock.calls[0] as [string]
    expect(url).toContain('/powersync/token')
  })

  it('fetchCredentials returns null and dispatches event when backend returns 410', async () => {
    setAuthToken(authToken)
    kyGetMock.mockReturnValue(createKyResponse({}, 410))
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: powersyncCredentialsInvalid, detail: { reason: 'account_deleted' } }),
    )
  })

  it('fetchCredentials returns null when backend returns 401 (no event)', async () => {
    setAuthToken(authToken)
    kyGetMock.mockReturnValue(createKyResponse({}, 401))
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('fetchCredentials returns null on network error', async () => {
    setAuthToken(authToken)
    kyGetMock.mockImplementation(() => {
      throw new Error('Network error')
    })
    const connector = new ThunderboltConnector(backendUrl)

    const result = await connector.fetchCredentials()

    expect(result).toBeNull()
  })
})
