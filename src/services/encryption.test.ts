/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { getAuthToken } from '@/lib/auth-token'
import { setCachedSession, clearCachedSession } from '@/lib/session-cache'
import { createAuthenticatedClient, type HttpClient } from '@/lib/http'
import {
  generateKeyPair,
  generateMlKemKeyPair,
  generateDEK,
  mintDEK,
  wrapAK,
  wrapDEK,
  unwrapDEK,
  deriveAKFromSeed,
  deriveSigningKeyPair,
  unwrapAK,
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  generateKdfSalt,
  createCanary,
  encrypt,
  decrypt,
  exportPublicKey,
  exportMlKemPublicKey,
  type StoredKeyPair,
} from '@/crypto'
import type { KeyId } from '@shared/e2ee-types'

// ---------------------------------------------------------------------------
// In-memory key storage (replaces IndexedDB)
// ---------------------------------------------------------------------------

let storedKeyPair: StoredKeyPair | null = null
let storedAK: CryptoKey | null = null
const storedDEKs = new Map<KeyId, string>()
let storedPrimaryKeyId: KeyId | null = null
let storedKeyVersion: number | null = null
/** Simulates an IndexedDB write failure inside `storeAK` (post-commit staging). */
let failStoreAK = false

// Capture the real module (spread into a fresh object — bun's mock.module mutates
// the live namespace in place, so only a value-copy survives) so afterAll can
// restore it. Without this the Map-backed stub below leaks globally and poisons
// crypto/key-storage.test.ts (real fake-indexeddb) into hangs. See testing.md §65.
const realKeyStorage = { ...(await import('@/crypto/key-storage')) }
afterAll(() => {
  mock.module('@/crypto/key-storage', () => realKeyStorage)
})

mock.module('@/crypto/key-storage', () => ({
  storeKeyPair: async (ecdhPriv: CryptoKey, ecdhPub: CryptoKey, mlkemPub: Uint8Array, mlkemSK: Uint8Array) => {
    storedKeyPair = {
      ecdhPrivateKey: ecdhPriv,
      ecdhPublicKey: ecdhPub,
      mlkemPublicKey: mlkemPub,
      mlkemSecretKey: mlkemSK,
    }
  },
  getKeyPair: async () => storedKeyPair,
  storeAK: async (ak: CryptoKey) => {
    if (failStoreAK) {
      throw new Error('IndexedDB unavailable')
    }
    storedAK = ak
  },
  getAK: async () => storedAK,
  storeDEK: async (keyId: KeyId, wrapped: string) => {
    storedDEKs.set(keyId, wrapped)
  },
  getDEK: async (keyId: KeyId) => storedDEKs.get(keyId) ?? null,
  stageWrappedDEKs: async (entries: Array<{ keyId: KeyId; wrappedKey: string }>) => {
    for (const entry of entries) {
      storedDEKs.set(entry.keyId, entry.wrappedKey)
    }
  },
  listDEKs: async () => [...storedDEKs].map(([keyId, wrappedKey]) => ({ keyId, wrappedKey })),
  storePrimaryKeyId: async (keyId: KeyId) => {
    storedPrimaryKeyId = keyId
  },
  getPrimaryKeyId: async () => storedPrimaryKeyId,
  storeKeyVersion: async (version: number) => {
    storedKeyVersion = version
  },
  getKeyVersion: async () => storedKeyVersion,
  clearAllKeys: async () => {
    storedKeyPair = null
    storedAK = null
    storedDEKs.clear()
    storedPrimaryKeyId = null
    storedKeyVersion = null
  },
}))

const {
  registerThisDevice,
  completeFirstDeviceSetup,
  approveDevice,
  checkApprovalAndUnwrap,
  recoverWithKey,
  rotateAK,
  revokeDeviceAndRotate,
  RotationStaleError,
  migrateToV2,
  followToV2,
  ensureV2Encryption,
  handleFullWipe,
} = await import('./encryption')

// ---------------------------------------------------------------------------
// Stateful fake backend
// ---------------------------------------------------------------------------

type MetaState = {
  canaryIv: string | null
  canaryCtext: string | null
  kdfSalt: string | null
  signingPublicKey: string | null
  keyVersion: number
  primaryKeyId: KeyId
  schemeVersion: 1 | 2
}

type FakeServer = {
  metadata: MetaState | null
  envelopes: Map<string, string>
  wrappedKeys: Map<KeyId, string>
  deviceTrusted: Map<string, boolean>
  upgradeConflict: boolean
  /** Applied when /upgrade returns 409 — simulates the winning migrator's committed v2 state. */
  winner?: { metadata: MetaState; envelopes: Map<string, string>; wrappedKeys: Map<KeyId, string> }
  rotateStatus: number
  /** Status for `POST /encryption/keys` — lets a DEK rotation fail mid-flow. */
  wrappedKeyStatus: number
  fetch: (input: Request) => Promise<Response>
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const createFakeServer = (): FakeServer => {
  const server: FakeServer = {
    metadata: null,
    envelopes: new Map(),
    wrappedKeys: new Map(),
    deviceTrusted: new Map(),
    upgradeConflict: false,
    rotateStatus: 200,
    wrappedKeyStatus: 200,
    fetch: async () => jsonResponse({}),
  }

  let nonceCounter = 0

  server.fetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url)
    const path = url.pathname
    const method = input.method
    const callerDeviceId = input.headers.get('x-device-id') ?? ''
    let body: Record<string, unknown> | null = null
    try {
      body = (await input.json()) as Record<string, unknown>
    } catch {
      // GET requests have no body
    }

    const metaResponse = () =>
      server.metadata
        ? jsonResponse({
            canary_iv: server.metadata.canaryIv,
            canary_ctext: server.metadata.canaryCtext,
            kdf_salt: server.metadata.kdfSalt,
            signing_public_key: server.metadata.signingPublicKey,
            key_version: server.metadata.keyVersion,
            primary_key_id: server.metadata.primaryKeyId,
            scheme_version: server.metadata.schemeVersion,
          })
        : jsonResponse({ error: 'not set up' }, 404)

    if (path === '/devices' && method === 'POST') {
      const deviceId = body!.deviceId as string
      if (!server.deviceTrusted.has(deviceId)) {
        server.deviceTrusted.set(deviceId, false)
      }
      return jsonResponse({ trusted: false })
    }
    if (path === '/devices/me/envelope' && method === 'GET') {
      const env = server.envelopes.get(callerDeviceId)
      if (!env) {
        return jsonResponse({ error: 'not found' }, 404)
      }
      return jsonResponse({ trusted: server.deviceTrusted.get(callerDeviceId) ?? false, wrappedCK: env })
    }
    if (path.endsWith('/envelope') && method === 'POST') {
      const deviceId = decodeURIComponent(path.split('/')[2])
      server.envelopes.set(deviceId, body!.wrappedCK as string)
      server.deviceTrusted.set(deviceId, true)
      if (body!.canaryIv) {
        // Bootstrap: create metadata + initial keyring atomically.
        server.metadata = {
          canaryIv: body!.canaryIv as string,
          canaryCtext: body!.canaryCtext as string,
          kdfSalt: body!.kdfSalt as string,
          signingPublicKey: body!.signingPublicKey as string,
          keyVersion: 1,
          primaryKeyId: '0',
          schemeVersion: 2,
        }
        for (const entry of (body!.wrappedKeys as Array<{ keyId: KeyId; wrappedKey: string }>) ?? []) {
          server.wrappedKeys.set(entry.keyId, entry.wrappedKey)
        }
      }
      return jsonResponse({ trusted: true })
    }
    if (path === '/encryption/canary' && method === 'GET') {
      return metaResponse()
    }
    if (path === '/encryption/keys' && method === 'GET') {
      return jsonResponse({ keys: [...server.wrappedKeys].map(([key_id, wrapped_key]) => ({ key_id, wrapped_key })) })
    }
    if (path.startsWith('/encryption/keys/') && method === 'GET') {
      const keyId = decodeURIComponent(path.slice('/encryption/keys/'.length))
      const wrapped = server.wrappedKeys.get(keyId)
      return wrapped ? jsonResponse({ key_id: keyId, wrapped_key: wrapped }) : jsonResponse({ error: 'not found' }, 404)
    }
    if (path === '/encryption/keys' && method === 'POST') {
      if (server.wrappedKeyStatus !== 200) {
        return jsonResponse({ error: 'boom' }, server.wrappedKeyStatus)
      }
      server.wrappedKeys.set(body!.keyId as KeyId, body!.wrappedKey as string)
      if (body!.setPrimary && server.metadata) {
        server.metadata.primaryKeyId = body!.keyId as KeyId
      }
      return jsonResponse({ key_id: body!.keyId })
    }
    if (path === '/encryption/challenge' && method === 'GET') {
      nonceCounter += 1
      return jsonResponse({ nonce: `nonce-${nonceCounter}`, expires_at: new Date(Date.now() + 300_000).toISOString() })
    }
    if (path === '/encryption/rotate' && method === 'POST') {
      if (server.rotateStatus !== 200) {
        return jsonResponse({ error: 'stale' }, server.rotateStatus)
      }
      for (const env of body!.envelopes as Array<{ deviceId: string; wrappedCK: string }>) {
        server.envelopes.set(env.deviceId, env.wrappedCK)
      }
      server.wrappedKeys.clear()
      for (const entry of body!.wrappedKeys as Array<{ keyId: KeyId; wrappedKey: string }>) {
        server.wrappedKeys.set(entry.keyId, entry.wrappedKey)
      }
      server.metadata = {
        ...server.metadata!,
        canaryIv: body!.canaryIv as string,
        canaryCtext: body!.canaryCtext as string,
        kdfSalt: body!.kdfSalt as string,
        signingPublicKey: body!.signingPublicKey as string,
        keyVersion: server.metadata!.keyVersion + 1,
      }
      return jsonResponse({ key_version: server.metadata.keyVersion })
    }
    if (path === '/encryption/upgrade' && method === 'POST') {
      if (server.upgradeConflict) {
        if (server.winner) {
          server.metadata = server.winner.metadata
          server.envelopes = server.winner.envelopes
          server.wrappedKeys = server.winner.wrappedKeys
        }
        return jsonResponse({ error: 'already migrated' }, 409)
      }
      for (const entry of body!.wrappedKeys as Array<{ keyId: KeyId; wrappedKey: string }>) {
        server.wrappedKeys.set(entry.keyId, entry.wrappedKey)
      }
      for (const env of body!.envelopes as Array<{ deviceId: string; wrappedCK: string }>) {
        server.envelopes.set(env.deviceId, env.wrappedCK)
      }
      server.metadata = {
        canaryIv: body!.canaryIv as string,
        canaryCtext: body!.canaryCtext as string,
        kdfSalt: body!.kdfSalt as string,
        signingPublicKey: body!.signingPublicKey as string,
        keyVersion: 1,
        primaryKeyId: body!.primaryKeyId as KeyId,
        schemeVersion: 2,
      }
      return jsonResponse({ key_version: 1, scheme_version: 2 })
    }
    return jsonResponse({})
  }

  return server
}

const clientFor = (server: FakeServer): HttpClient =>
  createAuthenticatedClient('http://test-api.local', getAuthToken, {
    fetch: server.fetch as unknown as typeof fetch,
  })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testUserId = 'test-user'
const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

/** Unwrap this device's staged envelope into the account AK (test convenience). */
const unwrapDeviceAK = async (server: FakeServer): Promise<CryptoKey> =>
  unwrapAK(server.envelopes.get('test-device-id')!, storedKeyPair!.ecdhPrivateKey, storedKeyPair!.mlkemSecretKey)

const generateFullKeyPair = async (): Promise<StoredKeyPair> => {
  const ecdhKeyPair = await generateKeyPair()
  const mlkemKeyPair = generateMlKemKeyPair()
  return {
    ecdhPrivateKey: ecdhKeyPair.privateKey,
    ecdhPublicKey: ecdhKeyPair.publicKey,
    mlkemPublicKey: mlkemKeyPair.publicKey,
    mlkemSecretKey: mlkemKeyPair.secretKey,
  }
}

const deviceKeysFor = async (kp: StoredKeyPair, id: string) => ({
  id,
  publicKey: await exportPublicKey(kp.ecdhPublicKey),
  mlkemPublicKey: exportMlKemPublicKey(kp.mlkemPublicKey),
})

/** Seed a full v2 account (AK + keyring incl. a `"v1"` slot + canary + envelope). */
const seedV2Account = async (
  server: FakeServer,
  kp: StoredKeyPair,
  legacyCK: CryptoKey,
  extraDekIds: KeyId[] = [],
): Promise<void> => {
  const seed = generateRecoverySeed()
  const kdfSalt = generateKdfSalt()
  const ak = await deriveAKFromSeed(seed, kdfSalt, { extractable: true })
  const { dek: dek0, wrappedKey: w0 } = await mintDEK(ak)
  server.wrappedKeys.set('0', w0)
  server.wrappedKeys.set('v1', await wrapDEK(legacyCK, ak))
  for (const id of extraDekIds) {
    const { wrappedKey } = await mintDEK(ak)
    server.wrappedKeys.set(id, wrappedKey)
  }
  const { canaryIv, canaryCtext, canarySecret } = await createCanary(dek0, testUserId, '0')
  const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)
  server.envelopes.set('test-device-id', await wrapAK(ak, kp.ecdhPublicKey, kp.mlkemPublicKey))
  server.deviceTrusted.set('test-device-id', true)
  server.metadata = {
    canaryIv,
    canaryCtext,
    kdfSalt,
    signingPublicKey: publicKeySpki,
    keyVersion: 1,
    primaryKeyId: '0',
    schemeVersion: 2,
  }
}

/** Build a v1 (legacy) account: an AES-GCM CK, a no-AAD v1 canary, and a v1 envelope. */
const seedV1Account = async (
  server: FakeServer,
  kp: StoredKeyPair,
): Promise<{ legacyCK: CryptoKey; v1Secret: string }> => {
  const legacyCK = await generateDEK(true)
  const v1Secret = 'legacy-secret-abc'
  const { iv, ciphertext } = await encrypt(`thunderbolt-canary-v1:${v1Secret}`, legacyCK)
  server.metadata = {
    canaryIv: iv,
    canaryCtext: ciphertext,
    kdfSalt: null,
    signingPublicKey: null,
    keyVersion: 1,
    primaryKeyId: '0',
    schemeVersion: 1,
  }
  server.envelopes.set('test-device-id', await wrapAK(legacyCK, kp.ecdhPublicKey, kp.mlkemPublicKey))
  server.deviceTrusted.set('test-device-id', true)
  return { legacyCK, v1Secret }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('encryption service (v2)', () => {
  beforeEach(() => {
    localStorage.setItem(deviceIdKey, 'test-device-id')
    localStorage.setItem(authTokenKey, 'test-token')
    setCachedSession({ user: { id: testUserId }, session: { expiresAt: new Date(Date.now() + 3_600_000) } })
    storedKeyPair = null
    storedAK = null
    storedDEKs.clear()
    storedPrimaryKeyId = null
    storedKeyVersion = null
    failStoreAK = false
  })

  afterEach(() => {
    failStoreAK = false
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
    clearCachedSession()
  })

  describe('registerThisDevice', () => {
    it('generates and stores a key pair when none exists', async () => {
      const server = createFakeServer()
      const result = await registerThisDevice(clientFor(server))
      expect(storedKeyPair).not.toBeNull()
      expect(result).toEqual({ trusted: false })
    })
  })

  describe('completeFirstDeviceSetup', () => {
    it('mints DEK 0, stores AK + keyring + primary, returns a 24-word key', async () => {
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()

      const recoveryKey = await completeFirstDeviceSetup(clientFor(server))

      expect(recoveryKey.split(' ')).toHaveLength(24)
      expect(storedAK).not.toBeNull()
      expect(storedDEKs.has('0')).toBe(true)
      expect(storedPrimaryKeyId).toBe('0')
      expect(server.metadata?.schemeVersion).toBe(2)
      // The staged DEK 0 unwraps under the stored AK.
      const dek0 = await unwrapDEK(storedDEKs.get('0')!, storedAK!)
      expect(dek0.algorithm.name).toBe('AES-GCM')
    })

    it('throws when the key pair is missing', async () => {
      const server = createFakeServer()
      await expect(completeFirstDeviceSetup(clientFor(server))).rejects.toThrow('Key pair not found')
    })
  })

  describe('approveDevice', () => {
    it('rewraps the AK for the pending device and sends an approve proof', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const legacyCK = await generateDEK(true)
      await seedV2Account(server, kp, legacyCK)
      storedAK = await unwrapDeviceAK(server) // helper below
      // Stage DEK 0 locally so getCanarySecret can build the proof.
      storedDEKs.set('0', server.wrappedKeys.get('0')!)

      const pending = await generateFullKeyPair()
      await approveDevice(
        clientFor(server),
        'pending-dev',
        await exportPublicKey(pending.ecdhPublicKey),
        exportMlKemPublicKey(pending.mlkemPublicKey),
      )

      // The pending device now has an envelope it can unwrap.
      expect(server.envelopes.has('pending-dev')).toBe(true)
    })
  })

  describe('checkApprovalAndUnwrap', () => {
    it('unwraps + stores the AK and stages the keyring when approved', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))

      const result = await checkApprovalAndUnwrap(clientFor(server))

      expect(result).toBe(true)
      expect(storedAK).not.toBeNull()
      expect(storedDEKs.has('0')).toBe(true)
      expect(storedDEKs.has('v1')).toBe(true)
    })

    it('returns false when the envelope is not yet present (404)', async () => {
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      const result = await checkApprovalAndUnwrap(clientFor(server))
      expect(result).toBe(false)
    })
  })

  describe('recoverWithKey', () => {
    it('re-derives the AK from the phrase, verifies the canary, and self-approves', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      // First device establishes the account + recovery phrase.
      storedKeyPair = kp
      const recoveryKey = await completeFirstDeviceSetup(clientFor(server))

      // Simulate a fresh device: clear local key material.
      storedKeyPair = null
      storedAK = null
      storedDEKs.clear()

      await recoverWithKey(clientFor(server), recoveryKey)

      expect(storedAK).not.toBeNull()
      expect(storedDEKs.has('0')).toBe(true)
    })

    it('rejects a wrong recovery phrase', async () => {
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      await completeFirstDeviceSetup(clientFor(server))
      storedKeyPair = null
      storedAK = null
      storedDEKs.clear()

      const wrongPhrase = encodeRecoverySeed(generateRecoverySeed())
      await expect(recoverWithKey(clientFor(server), wrongPhrase)).rejects.toThrow('Invalid recovery key')
    })
  })

  describe('rotateAK', () => {
    it('re-wraps the whole keyring (0, v1, 1) under the new AK and returns a new phrase', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true), ['1'])
      await checkApprovalAndUnwrap(clientFor(server)) // loads AK + stages keyring

      const newPhrase = await rotateAK(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(newPhrase.split(' ')).toHaveLength(24)
      // Every key_id is re-wrapped and unwraps under the new stored AK.
      for (const keyId of ['0', 'v1', '1']) {
        expect(storedDEKs.has(keyId)).toBe(true)
        const dek = await unwrapDEK(storedDEKs.get(keyId)!, storedAK!)
        expect(dek.algorithm.name).toBe('AES-GCM')
      }
    })

    it('throws RotationStaleError and refreshes the AK on a 4xx', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      server.rotateStatus = 400

      await expect(
        rotateAK(clientFor(server), { listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')] }),
      ).rejects.toBeInstanceOf(RotationStaleError)
    })

    it('still returns the new phrase when post-commit local staging fails', async () => {
      // The server already replaced the AK, so the old phrase is dead. A local
      // IndexedDB failure must not swallow the only copy of the new one.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      failStoreAK = true

      const newPhrase = await rotateAK(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(newPhrase.split(' ')).toHaveLength(24)
      // And the phrase is the real one: it re-derives the AK the server now holds.
      const rederived = await deriveAKFromSeed(decodeRecoveryKey(newPhrase), server.metadata!.kdfSalt!, {
        extractable: true,
      })
      const dek0 = await unwrapDEK(server.wrappedKeys.get('0')!, rederived)
      expect(dek0.algorithm.name).toBe('AES-GCM')
    })
  })

  describe('revokeDeviceAndRotate', () => {
    it('revokes, rotates the DEK, and returns the new phrase', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      const newPhrase = await revokeDeviceAndRotate(clientFor(server), 'other-device', {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(newPhrase.split(' ')).toHaveLength(24)
      // A fresh DEK became primary, and the whole keyring rides the new AK.
      expect(server.metadata?.primaryKeyId).toBe('1')
      for (const keyId of ['0', 'v1', '1']) {
        const dek = await unwrapDEK(storedDEKs.get(keyId)!, storedAK!)
        expect(dek.algorithm.name).toBe('AES-GCM')
      }
    })

    it('leaves the previous phrase valid when the DEK rotation fails', async () => {
      // Regression: the DEK rotation used to run AFTER the AK rotation, so a
      // failure here invalidated the old phrase while the new one was never
      // returned — leaving the account with a phrase nobody knows.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const originalPhrase = await completeFirstDeviceSetup(clientFor(server))
      const saltBefore = server.metadata!.kdfSalt
      server.wrappedKeyStatus = 500

      await expect(
        revokeDeviceAndRotate(clientFor(server), 'other-device', {
          listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
        }),
      ).rejects.toThrow()

      // The AK rotation never ran, so the account still answers to the phrase
      // the user already wrote down.
      expect(server.metadata!.kdfSalt).toBe(saltBefore)
      storedKeyPair = null
      storedAK = null
      storedDEKs.clear()
      await recoverWithKey(clientFor(server), originalPhrase)
      expect(storedAK).not.toBeNull()
    })
  })

  describe('migrateToV2', () => {
    it('absorbs the v1 CK, mints a fresh primary, and migrates — legacy data still decrypts', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const { legacyCK } = await seedV1Account(server, kp)
      // A real legacy value on the wire, encrypted with the v1 CK and NO AAD.
      const legacyValue = await encrypt('hello legacy', legacyCK)

      const result = await migrateToV2(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(result.outcome).toBe('migrated')
      if (result.outcome !== 'migrated') {
        throw new Error('expected migrated')
      }
      expect(result.recoveryKey.split(' ')).toHaveLength(24)
      expect(storedAK).not.toBeNull()
      expect(storedDEKs.has('0')).toBe(true)
      expect(storedDEKs.has('v1')).toBe(true)
      expect(server.metadata?.schemeVersion).toBe(2)

      // Dual-read: the absorbed "v1" slot decrypts the legacy value end-to-end.
      const v1Dek = await unwrapDEK(storedDEKs.get('v1')!, storedAK!)
      const plaintext = await decrypt(legacyValue, v1Dek)
      expect(plaintext).toBe('hello legacy')
    })

    it('covers this device from local keys even when the synced devices table is empty', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV1Account(server, kp)

      // Simulate PowerSync replication lag: the synced `devices` table has not
      // surfaced this (freshly trusted) device yet. The migrator must still cover
      // itself from local key material — otherwise `envelopes` is empty and the
      // upgrade is rejected (this is the CI-only failure mode).
      const result = await migrateToV2(clientFor(server), {
        listTrustedDevices: async () => [],
      })

      expect(result.outcome).toBe('migrated')
      expect(server.envelopes.has('test-device-id')).toBe(true)
    })

    it('falls through to the follower path on a 409 CAS-loss (candidate AK discarded)', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const { legacyCK } = await seedV1Account(server, kp)

      // The winning migrator's committed v2 state — built on a throwaway server
      // and swapped in when this migrator's /upgrade loses the CAS (409).
      const winnerState = createFakeServer()
      await seedV2Account(winnerState, kp, legacyCK)
      server.winner = {
        metadata: winnerState.metadata!,
        envelopes: winnerState.envelopes,
        wrappedKeys: winnerState.wrappedKeys,
      }
      server.upgradeConflict = true

      const result = await migrateToV2(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
        getLegacyV1Sample: async () => null,
      })

      expect(result.outcome).toBe('followed')
      expect(storedAK).not.toBeNull() // obtained via the follower path
    })
  })

  describe('followToV2', () => {
    it('unwraps the AK, stages the keyring, and passes the continuity check', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const legacyCK = await generateDEK(true)
      await seedV2Account(server, kp, legacyCK)
      const legacySample = await encrypt('continuity', legacyCK)

      const result = await followToV2(clientFor(server), { getLegacyV1Sample: async () => legacySample })

      expect(result.outcome).toBe('followed')
      expect(storedAK).not.toBeNull()
      expect(storedDEKs.has('v1')).toBe(true)
    })

    it('rejects a keyring whose "v1" slot cannot decrypt legacy data (continuity failure)', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const realCK = await generateDEK(true)
      await seedV2Account(server, kp, realCK)
      // Sample encrypted with a DIFFERENT key — the staged "v1" slot can't read it.
      const impostorSample = await encrypt('tampered', await generateDEK(true))

      await expect(followToV2(clientFor(server), { getLegacyV1Sample: async () => impostorSample })).rejects.toThrow(
        'continuity check failed',
      )
    })

    it('returns awaiting-approval when no envelope exists yet', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      server.envelopes.delete('test-device-id')

      const result = await followToV2(clientFor(server), { getLegacyV1Sample: async () => null })
      expect(result.outcome).toBe('awaiting-approval')
    })
  })

  describe('ensureV2Encryption', () => {
    it('returns already-v2 when a local AK exists', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      storedAK = await unwrapDeviceAK(server)

      const result = await ensureV2Encryption(clientFor(server))
      expect(result.outcome).toBe('already-v2')
    })

    it('returns not-applicable when there is no encryption metadata', async () => {
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      const result = await ensureV2Encryption(clientFor(server))
      expect(result.outcome).toBe('not-applicable')
    })

    it('follows when scheme is v2 and there is no local AK', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const legacyCK = await generateDEK(true)
      await seedV2Account(server, kp, legacyCK)

      const result = await ensureV2Encryption(clientFor(server), { getLegacyV1Sample: async () => null })
      expect(result.outcome).toBe('followed')
      expect(storedAK).not.toBeNull()
    })
  })

  describe('handleFullWipe', () => {
    it('clears all key material', async () => {
      storedKeyPair = await generateFullKeyPair()
      storedAK = await generateDEK()
      storedDEKs.set('0', 'blob')

      await handleFullWipe()

      expect(storedKeyPair).toBeNull()
      expect(storedAK).toBeNull()
      expect(storedDEKs.size).toBe(0)
    })
  })
})
