/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { inferenceUsageReceiptHeader } from '@shared/inference-usage'
import {
  bytesToHex,
  deriveResponseKeys,
  encryptChunk,
  EXPORT_LABEL,
  EXPORT_LENGTH,
  hexToBytes,
  HPKE_REQUEST_INFO,
  Identity,
  RESPONSE_NONCE_LENGTH,
  Transport,
} from 'ehbp'
import { AEAD_AES_256_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256, type Key } from 'hpke'
import { SecureClient } from 'tinfoil'
import { createTinfoilClientLifecycle, isTinfoilTransportWedgedError } from './tinfoil-client'

/** Build the `SecureClient` slice consumed by the lifecycle. */
const createClient = (ready: () => Promise<void> = async () => {}): SecureClient =>
  ({
    ready,
    fetch: async () => new Response(),
    getBaseURL: () => 'https://enclave.example.com/v1/',
  }) as unknown as SecureClient

const responseSuite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM)
const responseInfo = new TextEncoder().encode(HPKE_REQUEST_INFO)
const responseExportLabel = new TextEncoder().encode(EXPORT_LABEL)

/** Frame one encrypted EHBP response chunk with its network-order length. */
const frameEncryptedChunk = (payload: Uint8Array): Uint8Array => {
  const framed = new Uint8Array(4 + payload.byteLength)
  new DataView(framed.buffer).setUint32(0, payload.byteLength, false)
  framed.set(payload, 4)
  return framed
}

/** Copy bytes into an ArrayBuffer accepted consistently by DOM Response typings. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/** Create a real SecureClient fetch path with attestation already represented by a real EHBP transport. */
const createReadySecureClient = async (): Promise<{ client: SecureClient; privateKey: Key }> => {
  const { publicKey, privateKey } = await responseSuite.GenerateKeyPair(true)
  const publicKeyBytes = new Uint8Array(await responseSuite.SerializePublicKey(publicKey))
  const identity = await Identity.fromPublicKeyHex(bytesToHex(publicKeyBytes))
  const transport = new Transport(identity, 'proxy.example.com')
  const client = new SecureClient({ baseURL: 'https://proxy.example.com/v1', userCacheSecret: 'test-secret' })
  Object.defineProperties(client, {
    initPromise: { value: Promise.resolve(), writable: true },
    resolvedBaseURL: { value: 'https://proxy.example.com/v1', writable: true },
    _transport: {
      value: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => transport.request(input, init),
        getSessionRecoveryToken: () => Promise.resolve(transport.getSessionRecoveryToken()),
      },
      writable: true,
    },
  })
  return { client, privateKey }
}

/** Build the enclave's encrypted response from the real request HPKE context. */
const buildEncryptedResponse = async (
  request: Request,
  privateKey: Key,
  plaintext: string,
  headers: Record<string, string>,
): Promise<Response> => {
  const encapsulatedKey = request.headers.get('Ehbp-Encapsulated-Key')
  if (!encapsulatedKey) {
    throw new Error('Expected a real EHBP request')
  }
  const requestEnc = hexToBytes(encapsulatedKey)
  const recipientContext = await responseSuite.SetupRecipient(privateKey, requestEnc, { info: responseInfo })
  const encryptedRequest = new Uint8Array(await request.arrayBuffer())
  const requestChunkLength = new DataView(encryptedRequest.buffer, encryptedRequest.byteOffset, 4).getUint32(0, false)
  await recipientContext.Open(encryptedRequest.slice(4, 4 + requestChunkLength))

  const responseNonce = crypto.getRandomValues(new Uint8Array(RESPONSE_NONCE_LENGTH))
  const exportedSecret = await recipientContext.Export(responseExportLabel, EXPORT_LENGTH)
  const keyMaterial = await deriveResponseKeys(exportedSecret, requestEnc, responseNonce)
  const ciphertext = await encryptChunk(keyMaterial, 0, new TextEncoder().encode(plaintext))

  return new Response(toArrayBuffer(frameEncryptedChunk(ciphertext)), {
    headers: { ...headers, 'Ehbp-Response-Nonce': bytesToHex(responseNonce) },
  })
}

describe('SecureClient proxy response contract', () => {
  it('preserves the usage receipt header through the real EHBP decrypt path', async () => {
    const { client, privateKey } = await createReadySecureClient()
    const receipt = 'iu1.canonicalPayload.canonicalSignature'
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        return buildEncryptedResponse(request, privateKey, 'decrypted response', {
          [inferenceUsageReceiptHeader]: receipt,
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    try {
      const response = await client.fetch('https://proxy.example.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'glm-5-2' }),
      })

      expect(await response.text()).toBe('decrypted response')
      expect(response.headers.get(inferenceUsageReceiptHeader)).toBe(receipt)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('passes a plaintext quota rejection through as a readable response', async () => {
    const { client } = await createReadySecureClient()
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        expect(request.headers.get('Ehbp-Encapsulated-Key')).not.toBeNull()
        return Response.json({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } }, { status: 429 })
      },
      { preconnect: originalFetch.preconnect },
    )

    try {
      const response = await client.fetch('https://proxy.example.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'glm-5-2' }),
      })

      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Tinfoil client lifecycle', () => {
  it('wraps malformed attestation responses, preserves telemetry fidelity, and evicts the client', async () => {
    const readyError = new SyntaxError('Unexpected token in attestation document')
    const failedClient = createClient(async () => {
      throw readyError
    })
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => failedClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await expect(lifecycle.getSystemTinfoilClient()).rejects.toMatchObject({
      name: 'TinfoilAttestationError',
      message: 'Tinfoil attestation failed: SyntaxError: Unexpected token in attestation document',
      cause: readyError,
    })
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)

    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'error',
      duration_ms: 0,
      error_name: 'SyntaxError',
      client: 'system',
    })
  })

  it('times out hung ready, evicts the client, and reports timeout telemetry', async () => {
    const hungClient = createClient(() => new Promise<void>(() => {}))
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => hungClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      timeoutMs: 1_000,
      trackAttestation,
    })

    const clientPromise = lifecycle.getSystemTinfoilClient()
    const resultPromise = clientPromise.then(
      (client) => ({ client }),
      (error: unknown) => ({ error }),
    )
    await getClock().tickAsync(1_000)
    await expect(resultPromise).resolves.toMatchObject({
      error: {
        name: 'TinfoilAttestationTimeoutError',
        message: 'Tinfoil attestation timed out after 1000ms',
      },
    })

    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)
    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'timeout',
      duration_ms: 1_000,
      error_name: 'TinfoilAttestationTimeoutError',
      client: 'system',
    })
  })

  it('evicts a rejected construction promise', async () => {
    const constructionError = new Error('module load failed')
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => {
      throw constructionError
    })
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
    })

    await expect(lifecycle.getSystemTinfoilClient()).rejects.toBe(constructionError)
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)
    expect(createClientFactory).toHaveBeenCalledTimes(2)
  })

  it('shares one system-client construction across concurrent callers', async () => {
    const client = createClient()
    const createClientFactory = mock(async () => client)
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1/',
    })

    const [first, second] = await Promise.all([lifecycle.getSystemTinfoilClient(), lifecycle.getSystemTinfoilClient()])

    expect(first).toBe(client)
    expect(second).toBe(client)
    expect(createClientFactory).toHaveBeenCalledTimes(1)
    expect(createClientFactory).toHaveBeenCalledWith('system', 'https://cloud.example.com/v1')
  })

  it('tracks successful system attestation', async () => {
    const client = createClient()
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: async () => client,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await lifecycle.getSystemTinfoilClient()

    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'success',
      duration_ms: 0,
      client: 'system',
    })
  })

  it('reports success once per client instance while awaiting ready on every call', async () => {
    const ready = mock(async () => {})
    const client = createClient(ready)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: async () => client,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getSystemTinfoilClient()

    expect(ready).toHaveBeenCalledTimes(3)
    expect(trackAttestation).toHaveBeenCalledTimes(1)
  })

  it('reports traced success when a turn reuses a prewarmed client', async () => {
    const client = createClient()
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: async () => client,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getSystemTinfoilClient({
      trace_id: 'trace-1',
      engine: 'legacy',
      provider: 'tinfoil',
      model_id: 'model-1',
    })

    expect(trackAttestation).toHaveBeenLastCalledWith({
      outcome: 'success',
      duration_ms: 0,
      client: 'system',
      trace_id: 'trace-1',
      engine: 'legacy',
      provider: 'tinfoil',
      model_id: 'model-1',
    })
  })

  it('times out and evicts when a later ready call hangs during re-attestation', async () => {
    const ready = mock(async (): Promise<void> => new Promise<void>(() => {}))
    ready.mockImplementationOnce(async () => {})
    const reattestingClient = createClient(ready)
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => reattestingClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      timeoutMs: 1_000,
      trackAttestation,
    })

    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(reattestingClient)
    const resultPromise = lifecycle.getSystemTinfoilClient().then(
      (client) => ({ client }),
      (error: unknown) => ({ error }),
    )
    await getClock().tickAsync(1_000)

    await expect(resultPromise).resolves.toMatchObject({
      error: { name: 'TinfoilAttestationTimeoutError' },
    })
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(healthyClient)
    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'timeout',
      duration_ms: 1_000,
      error_name: 'TinfoilAttestationTimeoutError',
      client: 'system',
    })
  })

  it('wraps unreachable attestation endpoints, tracks the underlying error, and evicts the client', async () => {
    const readyError = new TypeError('Failed to fetch')
    const failedClient = createClient(async () => {
      throw readyError
    })
    const healthyClient = createClient()
    const createClientFactory = mock(async () => healthyClient)
    createClientFactory.mockImplementationOnce(async () => failedClient)
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
      trackAttestation,
    })

    await expect(lifecycle.getTinfoilClient()).rejects.toMatchObject({
      name: 'TinfoilAttestationError',
      message: 'Tinfoil attestation failed: TypeError: Failed to fetch',
      cause: readyError,
    })
    await expect(lifecycle.getTinfoilClient()).resolves.toBe(healthyClient)

    expect(createClientFactory).toHaveBeenCalledTimes(2)
    expect(createClientFactory).toHaveBeenCalledWith('user', '')
    expect(trackAttestation).toHaveBeenCalledWith({
      outcome: 'error',
      duration_ms: 0,
      error_name: 'TypeError',
      client: 'user',
    })
  })
})

describe('isTinfoilTransportWedgedError', () => {
  it('matches SDK key-config mismatch errors by name', () => {
    const error = { name: 'KeyConfigMismatchError', message: 'key changed' }

    expect(isTinfoilTransportWedgedError(error)).toBe(true)
  })

  it('matches the SDK concurrent-reset null-transport TypeError', () => {
    const error = { name: 'TypeError', message: "Cannot read properties of null (reading 'fetch')" }

    expect(isTinfoilTransportWedgedError(error)).toBe(true)
  })

  it('does not classify unrelated errors for eviction', () => {
    expect(isTinfoilTransportWedgedError(new Error('network unavailable'))).toBe(false)
    expect(isTinfoilTransportWedgedError(new TypeError("Cannot read properties of null (reading 'baseURL')"))).toBe(
      false,
    )
  })
})
