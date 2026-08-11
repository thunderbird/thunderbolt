/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { type HttpClient } from '@/contexts'
import { getAuthToken } from '@/lib/auth-token'
import { createAuthenticatedClient, HttpError } from '@/lib/http'
import type { ChallengeProof, RotateRequest } from '@shared/e2ee-types'
import {
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  cancelPending,
  fetchEncryptionMetadata,
  checkCanaryExists,
  fetchWrappedKeys,
  fetchWrappedKey,
  postWrappedKey,
  fetchChallenge,
  postRotate,
  resetV1Encryption,
  denyDevice,
  revokeDevice,
  setDeviceNodeId,
} from './encryption'

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

const testProof: ChallengeProof = {
  signature: 'sig-base64',
  nonce: 'nonce-1',
  operation: 'approve',
  deviceId: 'test-device-id',
}

type CapturedRequest = { url: string; method: string; body: Record<string, unknown> | null; headers: Headers }

const createCapturingHttpClient = (
  mockResponse: unknown = {},
  status = 200,
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

    // A 204 Response must have a null body (Response constructor requirement).
    return new Response(status === 204 ? null : JSON.stringify(mockResponse), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return {
    httpClient: createAuthenticatedClient('http://test-api.local', getAuthToken, {
      fetch: mockFetch as unknown as typeof fetch,
    }),
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
      expect(req.headers.get('x-device-name')).toBeTruthy()
      expect(result).toEqual(mockResponse)
    })

    it('returns TRUSTED response with envelope', async () => {
      const mockResponse = { trusted: true as const, envelope: 'wrapped-ak-base64' }
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
    it('sends the full bootstrap payload for first-device setup', async () => {
      const mockResponse = { trusted: true as const }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await storeEnvelope(httpClient, {
        deviceId: 'dev-1',
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
        signingPublicKey: 'spki-base64',
        kdfSalt: 'salt-base64',
        wrappedKeys: [{ keyId: '0', wrappedKey: 'wrapped-dek-base64' }],
      })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev-1/envelope')
      expect(req.method).toBe('POST')
      expect(req.body).toEqual({
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
        signingPublicKey: 'spki-base64',
        kdfSalt: 'salt-base64',
        wrappedKeys: [{ keyId: '0', wrappedKey: 'wrapped-dek-base64' }],
      })
      expect(result).toEqual(mockResponse)
    })

    it('sends the proof variant for approval / self-recovery', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true })

      await storeEnvelope(httpClient, {
        deviceId: 'pending-dev',
        wrappedCK: 'wrapped-base64',
        proof: testProof,
      })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/pending-dev/envelope')
      expect(req.body).toEqual({ wrappedCK: 'wrapped-base64', proof: { ...testProof } })
    })

    it('URL-encodes device ID', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true })

      await storeEnvelope(httpClient, {
        deviceId: 'dev/special',
        wrappedCK: 'wrapped',
        proof: testProof,
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
      expect(req.headers.get('x-device-name')).toBeTruthy()
      expect(result).toEqual(mockResponse)
    })
  })

  describe('cancelPending', () => {
    it('sends POST /devices/me/cancel-pending with device authentication headers', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient(null, 204)

      await cancelPending(httpClient)

      const req = getLastRequest()
      expect(req.url).toContain('/devices/me/cancel-pending')
      expect(req.method).toBe('POST')
      expect(req.body).toBeNull()
      expect(req.headers.get('x-device-id')).toBe('test-device-id')
    })
  })

  describe('fetchEncryptionMetadata', () => {
    it('sends GET /encryption/canary and returns the typed metadata DTO', async () => {
      const mockResponse = {
        canary_iv: 'iv-base64',
        canary_ctext: 'ctext-base64',
        kdf_salt: 'salt-base64',
        signing_public_key: 'spki-base64',
        key_version: 3,
        primary_key_id: '2',
      }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await fetchEncryptionMetadata(httpClient)

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/canary')
      expect(req.method).toBe('GET')
      expect(req.headers.get('authorization')).toBe('Bearer test-token')
      expect(result).toEqual(mockResponse)
    })

    it('passes through null signing_public_key/kdf_salt (v1 account detection)', async () => {
      const { httpClient } = createCapturingHttpClient({
        canary_iv: 'iv',
        canary_ctext: 'ct',
        kdf_salt: null,
        signing_public_key: null,
        key_version: 1,
        primary_key_id: '0',
      })

      const result = await fetchEncryptionMetadata(httpClient)
      expect(result.signing_public_key).toBeNull()
      expect(result.kdf_salt).toBeNull()
    })
  })

  describe('checkCanaryExists', () => {
    it('returns true when metadata exists', async () => {
      const { httpClient } = createCapturingHttpClient({ canary_iv: 'iv' })
      expect(await checkCanaryExists(httpClient)).toBe(true)
    })

    it('returns false on 404', async () => {
      const { httpClient } = createCapturingHttpClient({ error: 'Encryption not set up' }, 404)
      expect(await checkCanaryExists(httpClient)).toBe(false)
    })

    it('rethrows non-404 errors', async () => {
      const { httpClient } = createCapturingHttpClient({ error: 'boom' }, 500)
      await expect(checkCanaryExists(httpClient)).rejects.toBeInstanceOf(HttpError)
    })
  })

  describe('wrapped-DEK keyring', () => {
    it('fetchWrappedKeys sends GET /encryption/keys', async () => {
      const mockResponse = { keys: [{ key_id: '0', wrapped_key: 'w0' }] }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await fetchWrappedKeys(httpClient)

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/keys')
      expect(req.method).toBe('GET')
      expect(result).toEqual(mockResponse)
    })

    it('fetchWrappedKey sends GET /encryption/keys/:keyId (URL-encoded)', async () => {
      const mockResponse = { key_id: 'ws/1', wrapped_key: 'w1' }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await fetchWrappedKey(httpClient, 'ws/1')

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/keys/ws%2F1')
      expect(result).toEqual(mockResponse)
    })

    it('postWrappedKey sends POST /encryption/keys with setPrimary', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ key_id: '1' })

      const result = await postWrappedKey(httpClient, { keyId: '1', wrappedKey: 'w1', setPrimary: true })

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/keys')
      expect(req.method).toBe('POST')
      expect(req.body).toEqual({ keyId: '1', wrappedKey: 'w1', setPrimary: true })
      expect(result).toEqual({ key_id: '1' })
    })
  })

  describe('fetchChallenge', () => {
    it('sends GET /encryption/challenge with the operation query param', async () => {
      const mockResponse = { nonce: 'nonce-1', expires_at: '2026-01-01T00:00:00.000Z' }
      const { httpClient, getLastRequest } = createCapturingHttpClient(mockResponse)

      const result = await fetchChallenge(httpClient, 'rotate')

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/challenge?operation=rotate')
      expect(req.method).toBe('GET')
      expect(req.headers.get('x-device-id')).toBe('test-device-id')
      expect(result).toEqual(mockResponse)
    })
  })

  describe('postRotate', () => {
    it('sends the full RotateRequest body', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ key_version: 2 })

      const body: RotateRequest = {
        proof: { ...testProof, operation: 'rotate' },
        envelopes: [{ deviceId: 'dev-1', wrappedCK: 'env-1' }],
        wrappedKeys: [
          { keyId: '0', wrappedKey: 'w0' },
          { keyId: '1', wrappedKey: 'w1' },
        ],
        canaryIv: 'iv',
        canaryCtext: 'ct',
        signingPublicKey: 'spki',
        kdfSalt: 'salt',
      }
      const result = await postRotate(httpClient, body)

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/rotate')
      expect(req.method).toBe('POST')
      expect(req.body).toEqual({ ...body, proof: { ...body.proof } })
      expect(result).toEqual({ key_version: 2 })
    })
  })

  describe('resetV1Encryption', () => {
    it('sends POST /encryption/reset with no body', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient(null, 204)

      await resetV1Encryption(httpClient)

      const req = getLastRequest()
      expect(req.url).toContain('/encryption/reset')
      expect(req.method).toBe('POST')
      expect(req.body).toBeNull()
    })
  })

  describe('proof-gated device management', () => {
    it('denyDevice carries the proof (and nothing else)', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient(null, 204)

      await denyDevice(httpClient, 'dev-1', { ...testProof, operation: 'deny' })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev-1/deny')
      expect(req.body).toEqual({ proof: { ...testProof, operation: 'deny' } })
    })

    it('revokeDevice carries the proof when provided', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient(null, 204)

      await revokeDevice(httpClient, 'dev-1', { ...testProof, operation: 'revoke' })

      const req = getLastRequest()
      expect(req.url).toContain('/account/devices/dev-1/revoke')
      expect(req.body).toEqual({ proof: { ...testProof, operation: 'revoke' } })
    })

    it('revokeDevice sends an empty body without a proof (pre-E2EE fallback)', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient(null, 204)

      await revokeDevice(httpClient, 'dev-1')

      const req = getLastRequest()
      expect(req.body).toEqual({})
    })

    it('setDeviceNodeId carries nodeId + proof', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ nodeId: 'node-1' })

      await setDeviceNodeId(httpClient, 'dev-1', 'node-1', { ...testProof, operation: 'node-id' })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev-1/node-id')
      expect(req.body).toEqual({ nodeId: 'node-1', proof: { ...testProof, operation: 'node-id' } })
    })
  })
})
