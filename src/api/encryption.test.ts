/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { type HttpClient } from '@/contexts'
import { getAuthToken } from '@/lib/auth-token'
import { createAuthenticatedClient } from '@/lib/http'
import type { ChallengeProof } from '@shared/e2ee-types'
import {
  registerDevice,
  storeEnvelope,
  fetchMyEnvelope,
  fetchEncryptionMetadata,
  fetchOrgPublicKey,
  fetchWrappedKeys,
  fetchWrappedKey,
  postWrappedKey,
  fetchChallenge,
  postRotate,
  postUpgrade,
  denyDevice,
  revokeDevice,
} from './encryption'

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

type CapturedRequest = { url: string; method: string; body: Record<string, unknown> | null; headers: Headers }

const createCapturingHttpClient = (
  mockResponse: unknown = {},
): { httpClient: HttpClient; getLastRequest: () => CapturedRequest } => {
  let lastRequest: CapturedRequest = { url: '', method: 'GET', body: null, headers: new Headers() }

  const mockFetch = async (input: Request): Promise<Response> => {
    let body: Record<string, unknown> | null = null
    try {
      body = (await input.json()) as Record<string, unknown>
    } catch {
      // GET requests have no body
    }
    lastRequest = { url: input.url, method: input.method, body, headers: input.headers }
    return new Response(JSON.stringify(mockResponse), {
      status: 200,
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

const sampleProof: ChallengeProof = {
  signature: 'sig-base64',
  nonce: 'nonce-1',
  operation: 'approve',
  deviceId: 'dev-1',
}

/** The recovery slot triple every v2 write path must carry. */
const sampleRecoverySlot = {
  recoveryEcdhPublicKey: 'recovery-ecdh-base64',
  recoveryMlkemPublicKey: 'recovery-mlkem-base64',
  recoveryWrappedAK: 'recovery-wrapped-ak-base64',
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
    it('sends POST /devices with body + auth/device/app-version headers', async () => {
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
  })

  describe('storeEnvelope', () => {
    it('sends the bootstrap payload (canary + signing key + recovery slot + keyring, no proof)', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true })

      await storeEnvelope(httpClient, {
        deviceId: 'dev-1',
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
        signingPublicKey: 'spki-base64',
        kdfSalt: 'salt-base64',
        wrappedKeys: [{ keyId: '0', wrappedKey: 'dek0-base64' }],
        ...sampleRecoverySlot,
        orgEnvelope: 'org-wrapped-base64',
      })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev-1/envelope')
      expect(req.body).toEqual({
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
        signingPublicKey: 'spki-base64',
        kdfSalt: 'salt-base64',
        wrappedKeys: [{ keyId: '0', wrappedKey: 'dek0-base64' }],
        ...sampleRecoverySlot,
        orgEnvelope: 'org-wrapped-base64',
      })
    })

    it('omits orgEnvelope from the bootstrap body when undefined', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true })

      await storeEnvelope(httpClient, {
        deviceId: 'dev-1',
        wrappedCK: 'wrapped-base64',
        canaryIv: 'iv-base64',
        canaryCtext: 'ctext-base64',
        signingPublicKey: 'spki-base64',
        kdfSalt: 'salt-base64',
        wrappedKeys: [{ keyId: '0', wrappedKey: 'dek0-base64' }],
        ...sampleRecoverySlot,
        orgEnvelope: undefined,
      })

      expect(Object.keys(getLastRequest().body!)).not.toContain('orgEnvelope')
    })

    it('sends the proof-gated approval payload', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true })

      await storeEnvelope(httpClient, { deviceId: 'dev/special', wrappedCK: 'wrapped', proof: sampleProof })

      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev%2Fspecial/envelope')
      expect(req.body).toEqual({ wrappedCK: 'wrapped', proof: sampleProof })
    })
  })

  describe('metadata + keyring', () => {
    it('fetchEncryptionMetadata returns the full v2 DTO including scheme_version', async () => {
      const meta = {
        canary_iv: 'iv',
        canary_ctext: 'ct',
        kdf_salt: 'salt',
        signing_public_key: 'spki',
        recovery_ecdh_public_key: 'recovery-ecdh',
        recovery_mlkem_public_key: 'recovery-mlkem',
        recovery_wrapped_ak: 'recovery-wrapped-ak',
        key_version: 3,
        primary_key_id: '1',
        scheme_version: 2 as const,
      }
      const { httpClient, getLastRequest } = createCapturingHttpClient(meta)

      const result = await fetchEncryptionMetadata(httpClient)

      expect(getLastRequest().url).toContain('/encryption/canary')
      expect(result).toEqual(meta)
    })

    it('fetchOrgPublicKey hits /encryption/org-key and returns the DTO', async () => {
      const orgKey = { enabled: true, publicKey: 'org-pk-base64', fingerprint: 'fp-base64' }
      const { httpClient, getLastRequest } = createCapturingHttpClient(orgKey)

      const result = await fetchOrgPublicKey(httpClient)

      expect(getLastRequest().url).toContain('/encryption/org-key')
      expect(getLastRequest().method).toBe('GET')
      expect(result).toEqual(orgKey)
    })

    it('fetchWrappedKeys / fetchWrappedKey hit the keyring routes', async () => {
      const list = createCapturingHttpClient({ keys: [{ key_id: '0', wrapped_key: 'w0' }] })
      const keys = await fetchWrappedKeys(list.httpClient)
      expect(list.getLastRequest().url).toContain('/encryption/keys')
      expect(keys.keys).toHaveLength(1)

      const one = createCapturingHttpClient({ key_id: 'v1', wrapped_key: 'wv1' })
      const key = await fetchWrappedKey(one.httpClient, 'v1')
      expect(one.getLastRequest().url).toContain('/encryption/keys/v1')
      expect(key.wrapped_key).toBe('wv1')
    })

    it('postWrappedKey mints a new key_id', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ key_id: '1' })
      const proof = { signature: 'sig', nonce: 'n', operation: 'rotate' as const, deviceId: 'd1' }
      await postWrappedKey(httpClient, { keyId: '1', wrappedKey: 'w1', setPrimary: true, proof })
      const req = getLastRequest()
      expect(req.method).toBe('POST')
      expect(req.body).toEqual({ keyId: '1', wrappedKey: 'w1', setPrimary: true, proof })
    })
  })

  describe('challenge + rotate + upgrade', () => {
    it('fetchChallenge passes the operation as a query param', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ nonce: 'n', expires_at: 'later' })
      await fetchChallenge(httpClient, 'rotate')
      expect(getLastRequest().url).toContain('operation=rotate')
    })

    it('fetchMyEnvelope sends device headers', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ trusted: true, wrappedCK: 'w' })
      const result = await fetchMyEnvelope(httpClient)
      expect(getLastRequest().url).toContain('/devices/me/envelope')
      expect(result.wrappedCK).toBe('w')
    })

    it('postRotate posts the full rotation body including the recovery slot', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ key_version: 2 })
      const body = {
        proof: { ...sampleProof, operation: 'rotate' as const },
        envelopes: [{ deviceId: 'dev-1', wrappedCK: 'w' }],
        wrappedKeys: [{ keyId: '0', wrappedKey: 'w0' }],
        canaryIv: 'iv',
        canaryCtext: 'ct',
        signingPublicKey: 'spki',
        kdfSalt: 'salt',
        ...sampleRecoverySlot,
      }
      const result = await postRotate(httpClient, body)
      expect(getLastRequest().url).toContain('/encryption/rotate')
      expect(getLastRequest().body).toEqual(body)
      expect(result.key_version).toBe(2)
    })

    it('postUpgrade posts the migration body', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({ key_version: 1, scheme_version: 2 })
      const result = await postUpgrade(httpClient, {
        nonce: 'n',
        possessionProof: 'secret',
        envelopes: [{ deviceId: 'dev-1', wrappedCK: 'w' }],
        wrappedKeys: [
          { keyId: '0', wrappedKey: 'w0' },
          { keyId: 'v1', wrappedKey: 'wv1' },
        ],
        primaryKeyId: '0',
        canaryIv: 'iv',
        canaryCtext: 'ct',
        signingPublicKey: 'spki',
        kdfSalt: 'salt',
        ...sampleRecoverySlot,
      })
      expect(getLastRequest().url).toContain('/encryption/upgrade')
      expect(getLastRequest().body).toMatchObject(sampleRecoverySlot)
      expect(result).toEqual({ key_version: 1, scheme_version: 2 })
    })
  })

  describe('proof-gated device management', () => {
    it('denyDevice sends { proof }', async () => {
      const { httpClient, getLastRequest } = createCapturingHttpClient({})
      await denyDevice(httpClient, 'dev-2', { ...sampleProof, operation: 'deny' })
      const req = getLastRequest()
      expect(req.url).toContain('/devices/dev-2/deny')
      expect((req.body as { proof: ChallengeProof }).proof.operation).toBe('deny')
    })

    it('revokeDevice sends { proof } when supplied and {} otherwise', async () => {
      const withProof = createCapturingHttpClient({})
      await revokeDevice(withProof.httpClient, 'dev-3', { ...sampleProof, operation: 'revoke' })
      expect(withProof.getLastRequest().url).toContain('/account/devices/dev-3/revoke')
      expect(withProof.getLastRequest().body).toEqual({ proof: { ...sampleProof, operation: 'revoke' } })

      const noProof = createCapturingHttpClient({})
      await revokeDevice(noProof.httpClient, 'dev-4')
      expect(noProof.getLastRequest().body).toEqual({})
    })
  })
})
