/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { getAuthToken } from '@/lib/auth-token'
import { setCachedSession, clearCachedSession } from '@/lib/session-cache'
import { createAuthenticatedClient, type HttpClient } from '@/lib/http'
import {
  generateAK,
  generateKeyPair,
  generateMlKemKeyPair,
  generateDEK,
  mintDEK,
  wrapAK,
  wrapDEK,
  unwrapDEK,
  deriveRecoveryKeyPairFromSeed,
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
import { clearRecoveryPhrasePending, isRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
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
  stageKeyring,
  checkApprovalAndUnwrap,
  recoverWithKey,
  rotateAccountKey,
  changeRecoveryPhrase,
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
  recoveryEcdhPublicKey: string | null
  recoveryMlkemPublicKey: string | null
  recoveryWrappedAk: string | null
  keyVersion: number
  primaryKeyId: KeyId
  schemeVersion: 1 | 2
}

/** Pull the recovery slot triple off a request body into its stored shape. */
const recoverySlotFrom = (
  body: Record<string, unknown>,
): Pick<MetaState, 'recoveryEcdhPublicKey' | 'recoveryMlkemPublicKey' | 'recoveryWrappedAk'> => ({
  recoveryEcdhPublicKey: (body.recoveryEcdhPublicKey as string | undefined) ?? null,
  recoveryMlkemPublicKey: (body.recoveryMlkemPublicKey as string | undefined) ?? null,
  recoveryWrappedAk: (body.recoveryWrappedAK as string | undefined) ?? null,
})

type FakeServer = {
  metadata: MetaState | null
  envelopes: Map<string, string>
  wrappedKeys: Map<KeyId, string>
  deviceTrusted: Map<string, boolean>
  /** Public keys per device — absent means "cannot hold an envelope" (bridge, v1 device). */
  devicePublicKeys: Map<string, { publicKey: string; mlkemPublicKey: string }>
  upgradeConflict: boolean
  /** Applied when /upgrade returns 409 — simulates the winning migrator's committed v2 state. */
  winner?: { metadata: MetaState; envelopes: Map<string, string>; wrappedKeys: Map<KeyId, string> }
  rotateStatus: number
  /** Status for `POST /encryption/keys` — lets a DEK rotation fail mid-flow. */
  wrappedKeyStatus: number
  /** `METHOD /path` of every request, in order — lets a test assert nothing was called. */
  requests: string[]
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
    devicePublicKeys: new Map(),
    upgradeConflict: false,
    rotateStatus: 200,
    wrappedKeyStatus: 200,
    requests: [],
    fetch: async () => jsonResponse({}),
  }

  let nonceCounter = 0

  server.fetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url)
    const path = url.pathname
    const method = input.method
    const callerDeviceId = input.headers.get('x-device-id') ?? ''
    server.requests.push(`${method} ${path}`)
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
            recovery_ecdh_public_key: server.metadata.recoveryEcdhPublicKey,
            recovery_mlkem_public_key: server.metadata.recoveryMlkemPublicKey,
            recovery_wrapped_ak: server.metadata.recoveryWrappedAk,
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
      server.devicePublicKeys.set(deviceId, {
        publicKey: body!.publicKey as string,
        mlkemPublicKey: body!.mlkemPublicKey as string,
      })
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
          ...recoverySlotFrom(body!),
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
    if (path === '/encryption/envelope-targets' && method === 'GET') {
      // Mirrors the server predicate: trusted, non-revoked, both public keys present.
      const targets = [...server.deviceTrusted]
        .filter(([, trusted]) => trusted)
        .flatMap(([deviceId]) => {
          const keys = server.devicePublicKeys.get(deviceId)
          return keys
            ? [{ device_id: deviceId, public_key: keys.publicKey, mlkem_public_key: keys.mlkemPublicKey }]
            : []
        })
      return jsonResponse({ devices: targets })
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
        ...recoverySlotFrom(body!),
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
        ...recoverySlotFrom(body!),
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

// One derivation shared by every seeded fixture: PBKDF2-SHA512 at 600k
// iterations is far too slow to repeat per test, and no seeded-account test
// needs a distinct phrase.
const fixtureRecoverySalt = generateKdfSalt()
const fixtureRecoveryKeyPair = await deriveRecoveryKeyPairFromSeed(new Uint8Array(32).fill(7), fixtureRecoverySalt)

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
  const ak = await generateAK(true)
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
  server.devicePublicKeys.set('test-device-id', {
    publicKey: await exportPublicKey(kp.ecdhPublicKey),
    mlkemPublicKey: exportMlKemPublicKey(kp.mlkemPublicKey),
  })
  server.metadata = {
    canaryIv,
    canaryCtext,
    kdfSalt: fixtureRecoverySalt,
    signingPublicKey: publicKeySpki,
    recoveryEcdhPublicKey: await exportPublicKey(fixtureRecoveryKeyPair.ecdhPublicKey),
    recoveryMlkemPublicKey: exportMlKemPublicKey(fixtureRecoveryKeyPair.mlkemPublicKey),
    recoveryWrappedAk: await wrapAK(ak, fixtureRecoveryKeyPair.ecdhPublicKey, fixtureRecoveryKeyPair.mlkemPublicKey),
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
    recoveryEcdhPublicKey: null,
    recoveryMlkemPublicKey: null,
    recoveryWrappedAk: null,
    keyVersion: 1,
    primaryKeyId: '0',
    schemeVersion: 1,
  }
  server.envelopes.set('test-device-id', await wrapAK(legacyCK, kp.ecdhPublicKey, kp.mlkemPublicKey))
  server.deviceTrusted.set('test-device-id', true)
  server.devicePublicKeys.set('test-device-id', {
    publicKey: await exportPublicKey(kp.ecdhPublicKey),
    mlkemPublicKey: exportMlKemPublicKey(kp.mlkemPublicKey),
  })
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
    clearRecoveryPhrasePending()
  })

  afterEach(() => {
    failStoreAK = false
    clearRecoveryPhrasePending()
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

    it('marks the phrase as pending so a reload before confirmation is recoverable', async () => {
      // The returned phrase lives only in component state; the durable flag is
      // what lets the app re-prompt if the user never confirms saving it.
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      expect(isRecoveryPhrasePending()).toBe(false)

      await completeFirstDeviceSetup(clientFor(server))

      expect(isRecoveryPhrasePending()).toBe(true)
    })

    it('does not mark the phrase pending when setup fails', async () => {
      const server = createFakeServer()
      await expect(completeFirstDeviceSetup(clientFor(server))).rejects.toThrow()
      expect(isRecoveryPhrasePending()).toBe(false)
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

  describe('stageKeyring', () => {
    /**
     * Rotate the account elsewhere: re-wrap the server keyring under a brand-new
     * AK, replace this device's envelope with one carrying it, and bump the
     * version — exactly the state another device's rotation leaves behind.
     */
    const rotateOnServer = async (server: FakeServer, kp: StoredKeyPair): Promise<CryptoKey> => {
      const oldAK = await unwrapAK(server.envelopes.get('test-device-id')!, kp.ecdhPrivateKey, kp.mlkemSecretKey)
      const newAK = await generateAK(true)
      for (const [keyId, wrapped] of [...server.wrappedKeys]) {
        server.wrappedKeys.set(keyId, await wrapDEK(await unwrapDEK(wrapped, oldAK, true), newAK))
      }
      server.envelopes.set('test-device-id', await wrapAK(newAK, kp.ecdhPublicKey, kp.mlkemPublicKey))
      server.metadata!.keyVersion += 1
      return newAK
    }

    it('adopts the rotated AK instead of staging a keyring the stored AK cannot open', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      await rotateOnServer(server, kp)
      await stageKeyring(clientFor(server))

      // The invariant: whatever landed in IndexedDB opens under the stored AK.
      // Pre-fix this staged new-AK wrappings next to the old AK, and every
      // decode failed open to raw ciphertext until an unwrap-failed escalation.
      for (const keyId of ['0', 'v1']) {
        expect(await unwrapDEK(storedDEKs.get(keyId)!, storedAK!).then(() => true)).toBe(true)
      }
      expect(storedKeyVersion).toBe(2)
    })

    it('does not re-fetch the envelope when the stored AK still opens the keyring', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      server.requests.length = 0
      await stageKeyring(clientFor(server))

      expect(server.requests).not.toContain('GET /devices/me/envelope')
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

    it('rejects a wrong recovery phrase on the public-key comparison, before any further request', async () => {
      // The derivation is deterministic, so a wrong phrase is caught offline by
      // comparing against the stored public keys — no registration round trip.
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      await completeFirstDeviceSetup(clientFor(server))
      storedKeyPair = null
      storedAK = null
      storedDEKs.clear()
      server.requests.length = 0

      const wrongPhrase = encodeRecoverySeed(generateRecoverySeed())
      await expect(recoverWithKey(clientFor(server), wrongPhrase)).rejects.toThrow('Invalid recovery key')

      expect(server.requests).toEqual(['GET /encryption/canary'])
    })

    it('rejects a v2 account whose recovery slot was never written', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      server.metadata!.recoveryWrappedAk = null
      storedKeyPair = null

      await expect(recoverWithKey(clientFor(server), encodeRecoverySeed(generateRecoverySeed()))).rejects.toThrow(
        'has not finished upgrading',
      )
    })
  })

  describe('rotateAccountKey', () => {
    it('re-wraps the whole keyring (0, v1, 1) under the new AK', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true), ['1'])
      await checkApprovalAndUnwrap(clientFor(server)) // loads AK + stages keyring

      await rotateAccountKey(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      // Every key_id is re-wrapped and unwraps under the new stored AK.
      for (const keyId of ['0', 'v1', '1']) {
        expect(storedDEKs.has(keyId)).toBe(true)
        const dek = await unwrapDEK(storedDEKs.get(keyId)!, storedAK!)
        expect(dek.algorithm.name).toBe('AES-GCM')
      }
    })

    it('re-anchors the recovery slot to the existing phrase without minting a new one', async () => {
      // The whole point of the indirection: the AK changes, the phrase does not.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      const wrappedAkBefore = server.metadata!.recoveryWrappedAk

      await rotateAccountKey(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(server.metadata!.kdfSalt).toBe(fixtureRecoverySalt)
      expect(server.metadata!.recoveryEcdhPublicKey).toBe(await exportPublicKey(fixtureRecoveryKeyPair.ecdhPublicKey))
      expect(server.metadata!.recoveryWrappedAk).not.toBe(wrappedAkBefore)
      // The unchanged phrase still opens the NEW account key.
      const recoveredAK = await unwrapAK(
        server.metadata!.recoveryWrappedAk!,
        fixtureRecoveryKeyPair.ecdhPrivateKey,
        fixtureRecoveryKeyPair.mlkemSecretKey,
      )
      const dek0 = await unwrapDEK(server.wrappedKeys.get('0')!, recoveredAK)
      expect(dek0.algorithm.name).toBe('AES-GCM')
    })

    it('does not mark a recovery phrase pending — the user has nothing new to write down', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      await rotateAccountKey(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(isRecoveryPhrasePending()).toBe(false)
    })

    it('throws instead of silently minting a phrase when the recovery slot is missing', async () => {
      // A v2 account with null recovery columns is broken, not a fresh account —
      // quietly issuing a new phrase mid-revoke would strand the user's old one.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      server.metadata!.recoveryEcdhPublicKey = null
      server.metadata!.recoveryMlkemPublicKey = null

      await expect(
        rotateAccountKey(clientFor(server), {
          listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
        }),
      ).rejects.toThrow('Account has no recovery slot')
    })

    it('throws RotationStaleError and refreshes the AK on a 4xx', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      server.rotateStatus = 400

      await expect(
        rotateAccountKey(clientFor(server), {
          listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
        }),
      ).rejects.toBeInstanceOf(RotationStaleError)
    })

    it('builds envelopes from the server list, skipping a trusted keyless bridge', async () => {
      // No `listTrustedDevices` seam here on purpose: this exercises the real
      // path, which asks the server who must be covered instead of reading the
      // PowerSync-synced `devices` table. A bridge is trusted but has no public
      // keys, so no envelope can exist for it — the server's coverage rule uses
      // the same predicate, so the rotation is accepted.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      server.deviceTrusted.set('bridge-1', true)

      await rotateAccountKey(clientFor(server))

      expect(server.envelopes.has('test-device-id')).toBe(true)
      expect(server.envelopes.has('bridge-1')).toBe(false)
    })
  })

  describe('changeRecoveryPhrase', () => {
    it('returns a phrase that opens the new AK, and marks it pending', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      const newPhrase = await changeRecoveryPhrase(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(newPhrase.split(' ')).toHaveLength(24)
      expect(isRecoveryPhrasePending()).toBe(true)
      expect(server.metadata!.kdfSalt).not.toBe(fixtureRecoverySalt)
      // The returned phrase is the real one: it opens the recovery envelope the
      // server now holds, which in turn unwraps the live keyring.
      const rkp = await deriveRecoveryKeyPairFromSeed(decodeRecoveryKey(newPhrase), server.metadata!.kdfSalt!)
      const recoveredAK = await unwrapAK(server.metadata!.recoveryWrappedAk!, rkp.ecdhPrivateKey, rkp.mlkemSecretKey)
      const dek0 = await unwrapDEK(server.wrappedKeys.get('0')!, recoveredAK)
      expect(dek0.algorithm.name).toBe('AES-GCM')
    })

    it('still returns the new phrase when post-commit local staging fails', async () => {
      // The server already re-anchored the recovery slot, so the old phrase is
      // dead. A local IndexedDB failure must not swallow the only copy of the new one.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      failStoreAK = true

      const newPhrase = await changeRecoveryPhrase(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(newPhrase.split(' ')).toHaveLength(24)
    })
  })

  describe('revokeDeviceAndRotate', () => {
    it('revokes, rotates the DEK, and rotates the AK — leaving the phrase untouched', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      await revokeDeviceAndRotate(clientFor(server), 'other-device', {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      // A fresh DEK became primary, and the whole keyring rides the new AK.
      expect(server.metadata?.primaryKeyId).toBe('1')
      for (const keyId of ['0', 'v1', '1']) {
        const dek = await unwrapDEK(storedDEKs.get(keyId)!, storedAK!)
        expect(dek.algorithm.name).toBe('AES-GCM')
      }
      // Revocation is silent: same phrase, same salt, nothing owed to the user.
      expect(server.metadata!.kdfSalt).toBe(fixtureRecoverySalt)
      expect(isRecoveryPhrasePending()).toBe(false)
      const recoveredAK = await unwrapAK(
        server.metadata!.recoveryWrappedAk!,
        fixtureRecoveryKeyPair.ecdhPrivateKey,
        fixtureRecoveryKeyPair.mlkemSecretKey,
      )
      expect(await unwrapDEK(server.wrappedKeys.get('1')!, recoveredAK)).toBeDefined()
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

      // The migrated account carries a recovery slot the new phrase can open.
      const rkp = await deriveRecoveryKeyPairFromSeed(decodeRecoveryKey(result.recoveryKey), server.metadata!.kdfSalt!)
      expect(server.metadata!.recoveryEcdhPublicKey).toBe(await exportPublicKey(rkp.ecdhPublicKey))
      const recoveredAK = await unwrapAK(server.metadata!.recoveryWrappedAk!, rkp.ecdhPrivateKey, rkp.mlkemSecretKey)
      expect(await unwrapDEK(server.wrappedKeys.get('0')!, recoveredAK)).toBeDefined()
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
      // Sample encrypted with a DIFFERENT key — the candidate "v1" slot can't read it.
      const impostorSample = await encrypt('tampered', await generateDEK(true))

      await expect(followToV2(clientFor(server), { getLegacyV1Sample: async () => impostorSample })).rejects.toThrow(
        'continuity check failed',
      )

      // Nothing persisted: a rejected keyring must not leave key material behind.
      expect(storedAK).toBeNull()
      expect(storedDEKs.size).toBe(0)
    })

    it('re-runs the continuity check on the next attempt after a rejection', async () => {
      // Regression: the keys used to be stored before the check, so a rejection
      // left an AK behind and `ensureV2Encryption` reported `already-v2` forever
      // — the check that had just failed never ran again.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      const impostorSample = await encrypt('tampered', await generateDEK(true))

      await expect(
        ensureV2Encryption(clientFor(server), { getLegacyV1Sample: async () => impostorSample }),
      ).rejects.toThrow('continuity check failed')

      // Second boot: still no AK, so the follower path (and the check) runs again.
      await expect(
        ensureV2Encryption(clientFor(server), { getLegacyV1Sample: async () => impostorSample }),
      ).rejects.toThrow('continuity check failed')
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
