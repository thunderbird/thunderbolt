import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import ky from 'ky'
import {
  generateKeyPair,
  generateCK,
  exportPublicKey,
  wrapCK,
  unwrapCK,
  encrypt,
  decrypt,
  encodeRecoveryKey,
  decodeRecoveryKey,
  createCanary,
  verifyCanary,
} from '@/crypto'

// ---------------------------------------------------------------------------
// In-memory key storage (replaces IndexedDB)
// ---------------------------------------------------------------------------

let storedKeyPair: { privateKey: CryptoKey; publicKey: CryptoKey } | null = null
let storedCK: CryptoKey | null = null

mock.module('@/crypto/key-storage', () => ({
  storeKeyPair: async (priv: CryptoKey, pub: CryptoKey) => {
    storedKeyPair = { privateKey: priv, publicKey: pub }
  },
  getKeyPair: async () => storedKeyPair,
  storeCK: async (ck: CryptoKey) => {
    storedCK = ck
  },
  getCK: async () => storedCK,
  clearCK: async () => {
    storedCK = null
  },
  clearAllKeys: async () => {
    storedKeyPair = null
    storedCK = null
  },
}))

// Import service under test (after key-storage mock, but API is real — uses mock fetch via httpClient)
const {
  registerThisDevice,
  completeFirstDeviceSetup,
  approveDevice,
  checkApprovalAndUnwrap,
  recoverWithKey,
  handleFullWipe,
} = await import('./encryption')

// ---------------------------------------------------------------------------
// HTTP client with capturing mock fetch
// ---------------------------------------------------------------------------

type CapturedRequest = { url: string; method: string; body: Record<string, unknown> | null }
type RouteHandler = (url: string, method: string) => unknown | undefined

const createTestHttpClient = (...handlers: RouteHandler[]) => {
  const requests: CapturedRequest[] = []

  const mockFetch = async (input: Request): Promise<Response> => {
    const url = input.url
    const method = input.method
    let body: Record<string, unknown> | null = null
    try {
      body = (await input.json()) as Record<string, unknown>
    } catch {
      // GET requests have no body
    }
    requests.push({ url, method, body })

    for (const handler of handlers) {
      const response = handler(url, method)
      if (response !== undefined) {
        if (response instanceof Error) {
          return new Response(JSON.stringify({ error: response.message }), {
            status: (response as Error & { status?: number }).status ?? 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  return {
    httpClient: ky.create({
      fetch: mockFetch as unknown as typeof fetch,
      prefixUrl: 'http://test-api.local',
      retry: 0,
    }),
    requests,
  }
}

// Route helpers
const respondToRegister =
  (response: unknown): RouteHandler =>
  (url, method) => {
    if (url.includes('/devices') && !url.includes('/envelope') && !url.includes('/me') && method === 'POST') {
      return response
    }
  }

const respondToStoreEnvelope =
  (response: unknown): RouteHandler =>
  (url, method) => {
    if (url.includes('/envelope') && method === 'POST') {
      return response
    }
  }

const respondToFetchEnvelope =
  (response: unknown): RouteHandler =>
  (url, method) => {
    if (url.includes('/devices/me/envelope') && method === 'GET') {
      return response
    }
  }

const respondToFetchCanary =
  (response: unknown): RouteHandler =>
  (url, method) => {
    if (url.includes('/encryption/canary') && method === 'GET') {
      return response
    }
  }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

describe('encryption service', () => {
  beforeEach(() => {
    localStorage.setItem(deviceIdKey, 'test-device-id')
    localStorage.setItem(authTokenKey, 'test-token')
    storedKeyPair = null
    storedCK = null
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
  })

  describe('registerThisDevice', () => {
    it('generates new key pair when none exists', async () => {
      const { httpClient, requests } = createTestHttpClient(respondToRegister({ trusted: false }))

      const result = await registerThisDevice(httpClient)

      expect(storedKeyPair).not.toBeNull()
      expect(storedKeyPair!.publicKey.algorithm.name).toBe('ECDH')
      expect(requests).toHaveLength(1)
      expect(requests[0].body?.deviceId).toBe('test-device-id')
      expect((requests[0].body?.publicKey as string).length).toBeGreaterThan(0)
      expect(result).toEqual({ trusted: false })
    })

    it('reuses existing key pair', async () => {
      const existing = await generateKeyPair()
      storedKeyPair = existing
      const exportedBefore = await exportPublicKey(existing.publicKey)

      const { httpClient, requests } = createTestHttpClient(respondToRegister({ trusted: false }))
      await registerThisDevice(httpClient)

      expect(storedKeyPair).toBe(existing)
      expect(requests[0].body?.publicKey).toBe(exportedBefore)
    })

    it('passes device ID, public key, and name to API', async () => {
      const { httpClient, requests } = createTestHttpClient(respondToRegister({ trusted: false }))
      await registerThisDevice(httpClient)

      expect(requests[0].url).toContain('/devices')
      expect(requests[0].method).toBe('POST')
      expect(requests[0].body?.deviceId).toBe('test-device-id')
      expect(typeof requests[0].body?.publicKey).toBe('string')
      expect(typeof requests[0].body?.name).toBe('string')
    })
  })

  describe('completeFirstDeviceSetup', () => {
    it('generates CK, canary, envelope, stores keys, returns recovery key', async () => {
      storedKeyPair = await generateKeyPair()

      const { httpClient: capturingClient, requests } = createTestHttpClient(respondToStoreEnvelope({ trusted: true }))

      const recoveryKey = await completeFirstDeviceSetup(capturingClient)

      // Recovery key is a valid 24-word mnemonic
      expect(recoveryKey.split(' ')).toHaveLength(24)
      // CK was stored locally (non-extractable)
      expect(storedCK).not.toBeNull()
      expect(storedCK!.algorithm.name).toBe('AES-GCM')
      expect(storedCK!.extractable).toBe(false)
      // Envelope was stored on server with canary
      const envelopeReq = requests.find((r) => r.url.includes('/envelope'))
      expect(envelopeReq).toBeDefined()
      expect((envelopeReq!.body?.wrappedCK as string).length).toBeGreaterThan(0)
      expect((envelopeReq!.body?.canaryIv as string).length).toBeGreaterThan(0)
      expect((envelopeReq!.body?.canaryCtext as string).length).toBeGreaterThan(0)
    })

    it('stored CK can decrypt data encrypted during setup', async () => {
      storedKeyPair = await generateKeyPair()

      const { httpClient: capturingClient, requests } = createTestHttpClient(respondToStoreEnvelope({ trusted: true }))

      const recoveryKey = await completeFirstDeviceSetup(capturingClient)

      // The stored non-extractable CK should be usable
      const encrypted = await encrypt('test data', storedCK!)
      const decrypted = await decrypt(encrypted, storedCK!)
      expect(decrypted).toBe('test data')

      // Recovery key should decode to a CK that can verify the canary
      const envelopeReq = requests.find((r) => r.url.includes('/envelope'))!
      const recoveredCK = await decodeRecoveryKey(recoveryKey)
      const { valid } = await verifyCanary(
        recoveredCK,
        envelopeReq.body!.canaryIv as string,
        envelopeReq.body!.canaryCtext as string,
      )
      expect(valid).toBe(true)
    })

    it('throws if key pair is missing', async () => {
      const { httpClient } = createTestHttpClient()
      await expect(completeFirstDeviceSetup(httpClient)).rejects.toThrow('Key pair not found')
    })
  })

  describe('approveDevice', () => {
    it('fetches own envelope, rewraps CK for pending device, stores envelope', async () => {
      const thisKeyPair = await generateKeyPair()
      storedKeyPair = thisKeyPair

      // Create a real CK and wrap it for this device (simulates existing envelope)
      const ck = await generateCK(true)
      const wrappedForThis = await wrapCK(ck, thisKeyPair.publicKey)

      // Pending device's key pair
      const pendingKeyPair = await generateKeyPair()
      const pendingPubBase64 = await exportPublicKey(pendingKeyPair.publicKey)

      const { httpClient, requests } = createTestHttpClient(
        respondToFetchEnvelope({ trusted: true, wrappedCK: wrappedForThis }),
        respondToStoreEnvelope({ trusted: true }),
      )

      await approveDevice(httpClient, 'pending-dev', pendingPubBase64)

      // Envelope was stored for the pending device
      const storeReq = requests.find((r) => r.url.includes('/envelope') && r.method === 'POST')
      expect(storeReq).toBeDefined()
      expect(storeReq!.url).toContain('pending-dev')

      // The wrapped CK should be unwrappable by the pending device
      const unwrappedCK = await unwrapCK(storeReq!.body!.wrappedCK as string, pendingKeyPair.privateKey)
      expect(unwrappedCK.algorithm.name).toBe('AES-GCM')
    })

    it('throws if key pair is missing', async () => {
      const { httpClient } = createTestHttpClient()
      await expect(approveDevice(httpClient, 'dev', 'key')).rejects.toThrow('Key pair not found')
    })
  })

  describe('checkApprovalAndUnwrap', () => {
    it('fetches envelope, unwraps CK, stores it, returns true', async () => {
      const keyPair = await generateKeyPair()
      storedKeyPair = keyPair
      const ck = await generateCK(true)
      const wrappedCK = await wrapCK(ck, keyPair.publicKey)

      const { httpClient } = createTestHttpClient(respondToFetchEnvelope({ trusted: true, wrappedCK }))

      const result = await checkApprovalAndUnwrap(httpClient)

      expect(result).toBe(true)
      expect(storedCK).not.toBeNull()
      expect(storedCK!.algorithm.name).toBe('AES-GCM')
    })

    it('returns false when envelope fetch returns 404 (not yet approved)', async () => {
      storedKeyPair = await generateKeyPair()

      const mockFetch = async (): Promise<Response> =>
        new Response('Not found', { status: 404, headers: { 'Content-Type': 'application/json' } })

      const httpClient = ky.create({
        fetch: mockFetch as unknown as typeof fetch,
        prefixUrl: 'http://test-api.local',
        retry: 0,
      })

      const result = await checkApprovalAndUnwrap(httpClient)
      expect(result).toBe(false)
    })

    it('throws when envelope fetch fails with non-404 error', async () => {
      storedKeyPair = await generateKeyPair()

      const mockFetch = async (): Promise<Response> =>
        new Response('Server error', { status: 500, headers: { 'Content-Type': 'application/json' } })

      const httpClient = ky.create({
        fetch: mockFetch as unknown as typeof fetch,
        prefixUrl: 'http://test-api.local',
        retry: 0,
      })

      await expect(checkApprovalAndUnwrap(httpClient)).rejects.toThrow()
    })

    it('throws when key pair is missing', async () => {
      const ck = await generateCK(true)
      const tempKeyPair = await generateKeyPair()
      const wrappedCK = await wrapCK(ck, tempKeyPair.publicKey)

      const { httpClient } = createTestHttpClient(respondToFetchEnvelope({ trusted: true, wrappedCK }))

      await expect(checkApprovalAndUnwrap(httpClient)).rejects.toThrow('Key pair not found')
    })
  })

  describe('recoverWithKey', () => {
    it('verifies canary, registers device, stores envelope and CK', async () => {
      const originalCK = await generateCK(true)
      const recoveryPhrase = await encodeRecoveryKey(originalCK)
      const { canaryIv, canaryCtext } = await createCanary(originalCK)

      const { httpClient, requests } = createTestHttpClient(
        respondToFetchCanary({ canaryIv, canaryCtext }),
        respondToRegister({ trusted: false }),
        respondToStoreEnvelope({ trusted: true }),
      )

      await recoverWithKey(httpClient, recoveryPhrase)

      // Key pair was generated and stored
      expect(storedKeyPair).not.toBeNull()
      // Device was registered
      expect(requests.some((r) => r.url.includes('/devices') && r.method === 'POST')).toBe(true)
      // Envelope was stored
      expect(requests.some((r) => r.url.includes('/envelope') && r.method === 'POST')).toBe(true)
      // CK was stored locally (non-extractable)
      expect(storedCK).not.toBeNull()
      expect(storedCK!.extractable).toBe(false)
    })

    it('reuses existing key pair during recovery', async () => {
      const existing = await generateKeyPair()
      storedKeyPair = existing

      const originalCK = await generateCK(true)
      const recoveryPhrase = await encodeRecoveryKey(originalCK)
      const { canaryIv, canaryCtext } = await createCanary(originalCK)

      const { httpClient } = createTestHttpClient(
        respondToFetchCanary({ canaryIv, canaryCtext }),
        respondToRegister({ trusted: false }),
        respondToStoreEnvelope({ trusted: true }),
      )

      await recoverWithKey(httpClient, recoveryPhrase)

      expect(storedKeyPair).toBe(existing)
    })

    it('throws on invalid recovery key (canary verification fails)', async () => {
      const originalCK = await generateCK(true)
      const differentCK = await generateCK(true)
      const { canaryIv, canaryCtext } = await createCanary(originalCK)
      const wrongPhrase = await encodeRecoveryKey(differentCK)

      const { httpClient } = createTestHttpClient(respondToFetchCanary({ canaryIv, canaryCtext }))

      await expect(recoverWithKey(httpClient, wrongPhrase)).rejects.toThrow('Invalid recovery key')
    })
  })

  describe('handleFullWipe', () => {
    it('clears all keys', async () => {
      storedKeyPair = await generateKeyPair()
      storedCK = await generateCK()

      await handleFullWipe()

      expect(storedKeyPair).toBeNull()
      expect(storedCK).toBeNull()
    })
  })
})
