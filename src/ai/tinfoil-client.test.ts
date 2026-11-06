/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
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
import { createTinfoilClientLifecycle as createLifecycle, isTinfoilTransportWedgedError } from './tinfoil-client'
import { AttestedTinfoilClient } from '@/attestation/tinfoil'
import { createAttestationStore } from '@/attestation/store'
import type { AttestationReporter, AttestationState } from '@/attestation/types'

/** Each lifecycle test owns its evidence store, including failures. */
const createTinfoilClientLifecycle = (options: Parameters<typeof createLifecycle>[0]) =>
  createLifecycle({ attestations: createAttestationStore(), ...options })

afterEach(() => mock.restore())

/** Build the `SecureClient` slice consumed by the lifecycle. */
const createClient = (ready: () => Promise<void> = async () => {}): SecureClient =>
  ({
    ready,
    fetch: async () => new Response(),
    getBaseURL: () => 'https://enclave.example.com/v1/',
    getVerificationDocument: () => ({}),
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
  it('scopes evidence to managed backend or BYOK and revokes reporters on eviction', async () => {
    const attestations = createAttestationStore()
    const config = { cloudUrl: 'https://one.example/v1/' }
    const reporters: AttestationReporter[] = []
    const verified: AttestationState = {
      status: 'verified',
      evidence: { provider: 'Tinfoil', endpoint: 'router.tinfoil.sh', verifiedAt: 0, checks: ['channel'], details: [] },
    }
    const lifecycle = createTinfoilClientLifecycle({
      attestations,
      getCloudUrl: () => config.cloudUrl,
      createClient: async (_type, _cloudUrl, reporter) => {
        reporters.push(reporter)
        return createClient(async () => reporter.publish(verified))
      },
    })
    await lifecycle.getSystemTinfoilClient()
    expect(attestations.getSnapshot('tinfoil:system:https://one.example/v1')).toBe(verified)
    expect(attestations.getSnapshot('tinfoil:user').status).toBe('idle')
    config.cloudUrl = 'https://two.example/v1'
    expect(attestations.getSnapshot('tinfoil:system:https://two.example/v1').status).toBe('idle')
    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getTinfoilClient()
    lifecycle.evictSystemTinfoilClient()
    lifecycle.evictUserTinfoilClient()
    reporters[1].publish(verified)
    reporters[2].publish(verified)
    expect(attestations.getSnapshot('tinfoil:system:https://two.example/v1').status).toBe('idle')
    expect(attestations.getSnapshot('tinfoil:user').status).toBe('idle')
    expect(attestations.getSnapshot('tinfoil:system:https://one.example/v1')).toBe(verified)
  })

  it('keeps a replacement client and its evidence when the evicted generation fails late', async () => {
    const attestations = createAttestationStore()
    const pending = Promise.withResolvers<void>()
    const oldClient = createClient(() => pending.promise)
    const replacement = createClient()
    const factory = mock(async (_type: 'system' | 'user', _cloudUrl: string, reporter: AttestationReporter) => {
      reporter.publish({
        status: 'verified',
        evidence: {
          provider: 'Tinfoil',
          endpoint: 'new.tinfoil.sh',
          verifiedAt: 0,
          checks: ['channel'],
          details: [],
        },
      })
      return replacement
    })
    factory.mockImplementationOnce(async () => oldClient)
    const lifecycle = createTinfoilClientLifecycle({
      attestations,
      createClient: factory,
      getCloudUrl: () => 'https://cloud/v1',
      trackAttestation: () => {},
    })
    const first = lifecycle.getSystemTinfoilClient().catch((error: unknown) => error)
    await getClock().tickAsync(0)
    lifecycle.evictSystemTinfoilClient()
    await lifecycle.getSystemTinfoilClient()
    pending.reject(new Error('old verification failed'))
    expect(await first).toMatchObject({ name: 'TinfoilAttestationError' })
    expect(attestations.getSnapshot('tinfoil:system:https://cloud/v1')).toMatchObject({
      status: 'verified',
      evidence: { endpoint: 'new.tinfoil.sh' },
    })
    await expect(lifecycle.getSystemTinfoilClient()).resolves.toBe(replacement)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('rejects an acquisition revoked during readiness even when the old SDK succeeds', async () => {
    const pending = Promise.withResolvers<void>()
    const factory = mock(async () => createClient(() => pending.promise))
    const lifecycle = createTinfoilClientLifecycle({
      createClient: factory,
      getCloudUrl: () => 'https://cloud/v1',
    })
    const result = lifecycle.getSystemTinfoilClient().catch((error: unknown) => error)
    await getClock().tickAsync(0)
    lifecycle.clearTinfoilClients()
    pending.resolve()
    expect(await result).toMatchObject({ name: 'TinfoilAttestationError' })
    await lifecycle.getSystemTinfoilClient()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('evicts only the failing client generation, even after a backend URL switch', async () => {
    const config = { cloudUrl: 'https://one/v1' }
    const factory = mock(async () => createClient())
    const lifecycle = createTinfoilClientLifecycle({
      createClient: factory,
      getCloudUrl: () => config.cloudUrl,
    })
    const first = await lifecycle.getSystemTinfoilClient()
    config.cloudUrl = 'https://two/v1'
    const second = await lifecycle.getSystemTinfoilClient()
    lifecycle.evictSystemTinfoilClient(first)
    expect(await lifecycle.getSystemTinfoilClient()).toBe(second)
    config.cloudUrl = 'https://one/v1'
    const replacement = await lifecycle.getSystemTinfoilClient()
    expect(replacement).not.toBe(first)
    lifecycle.evictSystemTinfoilClient(first)
    lifecycle.evictSystemTinfoilClient(createClient())
    expect(await lifecycle.getSystemTinfoilClient()).toBe(replacement)
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('does not let a stale BYOK client evict its replacement', async () => {
    const factory = mock(async () => createClient())
    const lifecycle = createTinfoilClientLifecycle({ createClient: factory, getCloudUrl: () => 'https://cloud/v1' })
    const first = await lifecycle.getTinfoilClient()
    lifecycle.evictUserTinfoilClient(first)
    const second = await lifecycle.getTinfoilClient()
    lifecycle.evictUserTinfoilClient(first)
    expect(await lifecycle.getTinfoilClient()).toBe(second)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('clears all cached identities and failed evidence, and rejects late callbacks', async () => {
    const attestations = createAttestationStore()
    const config = { cloudUrl: 'https://one/v1' }
    const reporters: AttestationReporter[] = []
    const factory = mock(async (_type: 'system' | 'user', _cloudUrl: string, reporter: AttestationReporter) => {
      reporters.push(reporter)
      return createClient()
    })
    const lifecycle = createTinfoilClientLifecycle({
      attestations,
      createClient: factory,
      getCloudUrl: () => config.cloudUrl,
    })
    await lifecycle.getSystemTinfoilClient()
    config.cloudUrl = 'https://two/v1'
    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getTinfoilClient()
    reporters[0].publish({ status: 'failed', reason: 'verification' })
    lifecycle.clearTinfoilClients()
    for (const reporter of reporters) {
      reporter.publish({ status: 'verifying' })
    }
    for (const key of ['tinfoil:system:https://one/v1', 'tinfoil:system:https://two/v1', 'tinfoil:user']) {
      expect(attestations.getSnapshot(key)).toEqual({ status: 'idle' })
    }
    await lifecycle.getSystemTinfoilClient()
    await lifecycle.getTinfoilClient()
    expect(factory).toHaveBeenCalledTimes(5)
  })

  it('catches synchronous factory errors and revokes their verifying state', async () => {
    const attestations = createAttestationStore()
    const constructionError = new Error('constructor failed')
    const factory = mock((): Promise<SecureClient> => {
      throw constructionError
    })
    const lifecycle = createTinfoilClientLifecycle({
      attestations,
      createClient: factory,
      getCloudUrl: () => 'https://cloud/v1',
    })
    await expect(lifecycle.getTinfoilClient()).rejects.toBe(constructionError)
    expect(attestations.getSnapshot('tinfoil:user')).toEqual({ status: 'failed', reason: 'verification' })
    factory.mockImplementation(async () => createClient())
    await lifecycle.getTinfoilClient()
    expect(factory).toHaveBeenCalledTimes(2)
  })

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
    spyOn(SecureClient.prototype, 'ready').mockImplementation(() => new Promise<void>(() => {}))
    const healthyClient = createClient()
    const createClientFactory = mock(
      async (_type: 'system' | 'user', _cloudUrl: string, _reporter: AttestationReporter): Promise<SecureClient> =>
        healthyClient,
    )
    createClientFactory.mockImplementationOnce(
      async (_type, _cloudUrl, reporter) => new AttestedTinfoilClient({ userCacheSecret: 'test' }, reporter, 1_000),
    )
    const trackAttestation = mock(() => {})
    const lifecycle = createTinfoilClientLifecycle({
      createClient: createClientFactory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
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
    expect(createClientFactory).toHaveBeenCalledWith('system', 'https://cloud.example.com/v1', expect.any(Object))
  })

  it('tracks successful system attestation', async () => {
    const client = createClient()
    const document = new SecureClient({ userCacheSecret: 'test' }).getVerificationDocument()
    Object.assign(document, {
      enclaveHost: 'router.tinfoil.sh',
      releaseDigest: 'release-digest',
      enclaveFingerprint: 'fingerprint',
      selectedRouterEndpoint: 'router.tinfoil.sh',
    })
    spyOn(client, 'getVerificationDocument').mockReturnValue(document)
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
      enclave_host: 'router.tinfoil.sh',
      release_digest: 'release-digest',
      enclave_fingerprint: 'fingerprint',
      router_endpoint: 'router.tinfoil.sh',
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
      engine: 'pi',
      provider: 'tinfoil',
      model_id: 'model-1',
    })

    expect(trackAttestation).toHaveBeenLastCalledWith({
      outcome: 'success',
      duration_ms: 0,
      client: 'system',
      trace_id: 'trace-1',
      engine: 'pi',
      provider: 'tinfoil',
      model_id: 'model-1',
    })
  })

  it('evicts immediately when re-attestation fails inside fetch, before another acquisition', async () => {
    const attestations = createAttestationStore()
    const reporters: AttestationReporter[] = []
    const factory = mock(async (_type: 'system' | 'user', _cloudUrl: string, reporter: AttestationReporter) => {
      reporters.push(reporter)
      return createClient()
    })
    const lifecycle = createTinfoilClientLifecycle({
      attestations,
      createClient: factory,
      getCloudUrl: () => 'https://cloud.example.com/v1',
    })
    const first = await lifecycle.getSystemTinfoilClient()
    reporters[0].publish({ status: 'failed', reason: 'timeout' })
    expect(attestations.getSnapshot('tinfoil:system:https://cloud.example.com/v1')).toEqual({
      status: 'failed',
      reason: 'timeout',
    })
    const replacement = await lifecycle.getSystemTinfoilClient()
    expect(replacement).not.toBe(first)
    expect(factory).toHaveBeenCalledTimes(2)
    reporters[0].publish({ status: 'failed', reason: 'verification' })
    expect(attestations.getSnapshot('tinfoil:system:https://cloud.example.com/v1').status).toBe('verifying')
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
    expect(createClientFactory).toHaveBeenCalledWith('user', '', expect.any(Object))
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
