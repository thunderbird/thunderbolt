import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { type HttpClient } from '@/contexts'
import { createClient } from '@/lib/http'
import { registerDevice, storeEnvelope, fetchMyEnvelope, fetchCanary } from './encryption'

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

type CapturedRequest = { url: string; method: string; body: Record<string, unknown> | null; headers: Headers }

const createCapturingHttpClient = (
  mockResponse: unknown = {},
): { httpClient: HttpClient; getLastRequest: () => CapturedRequest } => {
  let lastRequest: CapturedRequest = {
    url: '',
    method: 'GET',
    body: null,
    headers: new Headers(),
  }

  const mockFetch = async (input: Request): Promise<Response> => {
    const url = input.url
    const method = input.method
    const headers = input.headers
    let body: Record<string, unknown> | null = null
    try {
      body = (await input.json()) as Record<string, unknown>
    } catch {
      // GET requests have no body
    }
    lastRequest = { url, method, body, headers }

    return new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return {
    httpClient: createClient({ fetch: mockFetch as unknown as typeof fetch, prefixUrl: 'http://test-api.local' }),
    getLastRequest: () => lastRequest,
  }
}

describe('encryption API client', () => {
  beforeEach(() => {
    localStorage.setItem(deviceIdKey, 'test-device-id')
    localStorage.setItem(authTokenKey, 'test-token')
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
  })

  describe('registerDevice', () => {
    it('sends POST /devices with correct body and auth headers', async () => {
      const mockResponse = { trusted: false as const }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await registerDevice(httpClient, {
        deviceId: 'dev-1',
        publicKey: 'pk-base64',
        mlkemPublicKey: 'mlkem-pk-base64',
        name: 'Test Device',
      })

      const req = getLastRequest()
      expect(req.url).toContain('/devices')
      expect(req.method).toBe('POST')
      expect(req.body).toEqual({
        deviceId: 'dev-1',
        publicKey: 'pk-base64',
        mlkemPublicKey: 'mlkem-pk-base64',
        name: 'Test Device',
      })
      expect(req.headers.get('authorization')).toBe('Bearer test-token')
      expect(req.headers.get('x-device-id')).toBe('test-device-id')
      expect(result).toEqual(mockResponse)
    })

    it('returns TRUSTED response with envelope', async () => {
      const mockResponse = { trusted: true as const, envelope: 'wrapped-ck-base64' }
      const { httpClient } = createCapturingHttpClient(mockResponse)

      const result = await registerDevice(httpClient, {
        deviceId: 'dev-1',
        publicKey: 'pk-base64',
        mlkemPublicKey: 'mlkem-pk-base64',
      })

      expect(result).toEqual(mockResponse)
    })
  })

  describe('storeEnvelope', () => {
    it('sends POST /devices/:id/envelope with correct body', async () => {
      const mockResponse = { trusted: true as const }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await storeEnvelope(httpClient, {
        deviceId: 'dev-1',
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
      })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev-1/envelope')
      expect(req.method).toBe('POST')
      expect(req.body).toEqual({
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
      })
      expect(result).toEqual(mockResponse)
    })

    it('URL-encodes device ID', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true })

      await storeEnvelope(httpClient, {
        deviceId: 'dev/special',
        wrappedCK: 'wrapped',
      })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev%2Fspecial/envelope')
    })
  })

  describe('fetchMyEnvelope', () => {
    it('sends GET /devices/me/envelope with auth headers', async () => {
      const mockResponse = { trusted: true, wrappedCK: 'wrapped-base64' }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await fetchMyEnvelope(httpClient)

      const req = getLastRequest()
      expect(req.url).toContain('/devices/me/envelope')
      expect(req.method).toBe('GET')
      expect(req.headers.get('x-device-id')).toBe('test-device-id')
      expect(result).toEqual(mockResponse)
    })
  })

  describe('fetchCanary', () => {
    it('sends GET /encryption/canary with auth headers', async () => {
      const mockResponse = { canaryIv: 'iv-base64', canaryCtext: 'ctext-base64' }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await fetchCanary(httpClient)

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/canary')
      expect(req.method).toBe('GET')
      expect(req.headers.get('authorization')).toBe('Bearer test-token')
      expect(result).toEqual(mockResponse)
    })
  })
})
