/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test'
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
  signRecoveryAttestation,
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
  base64ToUint8Array,
  uint8ArrayToBase64,
  anchorVersion,
  keyringAnchorOpens,
  mintKeyringAnchor,
  type KeyringAnchor,
  type StoredKeyPair,
} from '@/crypto'
import { clearRecoveryPhrasePending, isRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
import { type KeyId, deviceBindHkdfInfo, ecdhKeyAlgorithm, initialKeyId, isMintableKeyId } from '@shared/e2ee-types'

// ---------------------------------------------------------------------------
// In-memory key storage (replaces IndexedDB)
// ---------------------------------------------------------------------------

let storedKeyPair: StoredKeyPair | null = null
let storedAK: CryptoKey | null = null
const storedDEKs = new Map<KeyId, string>()
let storedPrimaryKeyId: KeyId | null = null
let storedKeyVersion: number | null = null
let storedKeyringAnchor: KeyringAnchor | null = null
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
  storeKeyringAnchor: async (anchor: KeyringAnchor) => {
    storedKeyringAnchor = anchor
  },
  getKeyringAnchor: async () => storedKeyringAnchor,
  clearAllKeys: async () => {
    storedKeyPair = null
    storedAK = null
    storedDEKs.clear()
    storedPrimaryKeyId = null
    storedKeyVersion = null
    storedKeyringAnchor = null
  },
}))

const {
  ensureSessionBound,
  registerThisDevice,
  completeFirstDeviceSetup,
  buildOrgEnvelope,
  approveDevice,
  stageKeyring,
  checkApprovalAndUnwrap,
  recoverWithKey,
  rotateAccountKey,
  changeRecoveryPhrase,
  revokeDeviceAndRotate,
  RecoveryAnchorError,
  RotationStaleError,
  AKAnchorError,
  refreshAK,
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
  recoveryAttestation: string | null
  keyVersion: number
  primaryKeyId: KeyId
  schemeVersion: 1 | 2
}

/** Pull the recovery slot off a request body into its stored shape. */
const recoverySlotFrom = (
  body: Record<string, unknown>,
): Pick<
  MetaState,
  'recoveryEcdhPublicKey' | 'recoveryMlkemPublicKey' | 'recoveryWrappedAk' | 'recoveryAttestation'
> => ({
  recoveryEcdhPublicKey: (body.recoveryEcdhPublicKey as string | undefined) ?? null,
  recoveryMlkemPublicKey: (body.recoveryMlkemPublicKey as string | undefined) ?? null,
  recoveryWrappedAk: (body.recoveryWrappedAK as string | undefined) ?? null,
  recoveryAttestation: (body.recoveryAttestation as string | undefined) ?? null,
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
  /** `METHOD /path` of every request, in order — lets a test assert nothing was called. */
  requests: string[]
  /** Operator escrow config served by GET /encryption/org-key (THU-804). */
  orgEscrow: { enabled: boolean; publicKey: string | null }
  /** `orgEnvelope` from the last bootstrap/rotate/upgrade body — null when the field was omitted. */
  lastOrgEnvelope: string | null
  /** Device this session is bound to (THU-873) — set only by a completed bind handshake. */
  boundDeviceId: string | null
  /** Nonce the last bind-challenge sealed, so a test can assert it never leaked. */
  lastBindNonce: string | null
  fetch: (input: Request) => Promise<Response>
}

/**
 * Mirror of the BACKEND seal (`backend/src/lib/device-bind.ts`) so the fake
 * server can answer a bind challenge the way production does — the client half
 * under test then has to really open it with the device's private key.
 */
const sealForDevice = async (devicePublicKeyBase64: string, nonce: string) => {
  const devicePublicKey = await crypto.subtle.importKey(
    'raw',
    base64ToUint8Array(devicePublicKeyBase64),
    ecdhKeyAlgorithm,
    false,
    [],
  )
  const ephemeral = await crypto.subtle.generateKey(ecdhKeyAlgorithm, false, ['deriveBits'])
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const shared = await crypto.subtle.deriveBits(
    { name: ecdhKeyAlgorithm.name, public: devicePublicKey },
    ephemeral.privateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const sealingKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralRaw as BufferSource,
      info: new TextEncoder().encode(deviceBindHkdfInfo),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sealingKey, new TextEncoder().encode(nonce))
  return {
    ephemeral_public_key: uint8ArrayToBase64(ephemeralRaw),
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
  }
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
    requests: [],
    orgEscrow: { enabled: false, publicKey: null },
    lastOrgEnvelope: null,
    boundDeviceId: null,
    lastBindNonce: null,
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
            recovery_attestation: server.metadata.recoveryAttestation,
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
        server.lastOrgEnvelope = (body!.orgEnvelope as string | undefined) ?? null
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
    if (path === '/devices/me/bind-challenge' && method === 'GET') {
      const keys = server.devicePublicKeys.get(callerDeviceId)
      if (!keys) {
        return jsonResponse({ error: 'Device not found' }, 404)
      }
      const nonce = `bind-nonce-${++nonceCounter}`
      server.lastBindNonce = nonce
      return jsonResponse({
        sealed: await sealForDevice(keys.publicKey, nonce),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })
    }
    if (path === '/devices/me/bind' && method === 'POST') {
      if (body!.nonce !== server.lastBindNonce) {
        return jsonResponse({ error: 'Invalid or expired bind nonce' }, 403)
      }
      server.boundDeviceId = body!.deviceId as string
      return jsonResponse({ deviceId: server.boundDeviceId })
    }
    if (path === '/encryption/canary' && method === 'GET') {
      return metaResponse()
    }
    if (path === '/encryption/org-key' && method === 'GET') {
      const { enabled, publicKey } = server.orgEscrow
      return jsonResponse({ enabled, publicKey, fingerprint: publicKey ? 'test-fingerprint' : null })
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
    if (path === '/encryption/challenge' && method === 'GET') {
      nonceCounter += 1
      return jsonResponse({ nonce: `nonce-${nonceCounter}`, expires_at: new Date(Date.now() + 300_000).toISOString() })
    }
    if (path === '/encryption/rotate' && method === 'POST') {
      if (server.rotateStatus !== 200) {
        return jsonResponse({ error: 'stale' }, server.rotateStatus)
      }
      server.lastOrgEnvelope = (body!.orgEnvelope as string | undefined) ?? null
      for (const env of body!.envelopes as Array<{ deviceId: string; wrappedCK: string }>) {
        server.envelopes.set(env.deviceId, env.wrappedCK)
      }
      // A rotation may mint one new primary DEK (THU-871). Mirror the server's
      // conflict check: a key_id that already exists aborts the whole rotation,
      // it is never silently swallowed.
      const newPrimaryKey = body!.newPrimaryKey as { keyId: KeyId; wrappedKey: string } | undefined
      if (newPrimaryKey && server.wrappedKeys.has(newPrimaryKey.keyId)) {
        return jsonResponse({ error: `key_id '${newPrimaryKey.keyId}' already exists — mint aborted` }, 409)
      }
      server.wrappedKeys.clear()
      for (const entry of body!.wrappedKeys as Array<{ keyId: KeyId; wrappedKey: string }>) {
        server.wrappedKeys.set(entry.keyId, entry.wrappedKey)
      }
      if (newPrimaryKey) {
        server.wrappedKeys.set(newPrimaryKey.keyId, newPrimaryKey.wrappedKey)
      }
      server.metadata = {
        ...server.metadata!,
        ...(newPrimaryKey ? { primaryKeyId: newPrimaryKey.keyId } : {}),
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
      server.lastOrgEnvelope = (body!.orgEnvelope as string | undefined) ?? null
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
  // Signed for real with this epoch's canary secret, exactly as a live setup
  // would (THU-865) — a stubbed value here would make every rotation test fail
  // the anchor check instead of exercising it.
  const recoveryEcdhPublicKey = await exportPublicKey(fixtureRecoveryKeyPair.ecdhPublicKey)
  const recoveryMlkemPublicKey = exportMlKemPublicKey(fixtureRecoveryKeyPair.mlkemPublicKey)
  server.metadata = {
    canaryIv,
    canaryCtext,
    kdfSalt: fixtureRecoverySalt,
    signingPublicKey: publicKeySpki,
    recoveryEcdhPublicKey,
    recoveryMlkemPublicKey,
    recoveryWrappedAk: await wrapAK(ak, fixtureRecoveryKeyPair.ecdhPublicKey, fixtureRecoveryKeyPair.mlkemPublicKey),
    recoveryAttestation: await signRecoveryAttestation(canarySecret, {
      userId: testUserId,
      kdfSalt: fixtureRecoverySalt,
      recoveryEcdhPublicKey,
      recoveryMlkemPublicKey,
    }),
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
    recoveryAttestation: null,
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
    storedKeyringAnchor = null
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

  describe('ensureSessionBound (THU-873)', () => {
    it('opens the sealed challenge and binds the session to this device', async () => {
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      // The device is registered, so the server holds its public key to seal to —
      // the state a returning device is in after its session expired.
      server.devicePublicKeys.set('test-device-id', {
        publicKey: await exportPublicKey(storedKeyPair.ecdhPublicKey),
        mlkemPublicKey: exportMlKemPublicKey(storedKeyPair.mlkemPublicKey),
      })

      await ensureSessionBound(clientFor(server))

      expect(server.boundDeviceId).toBe('test-device-id')
    })

    it('does nothing when this device holds no key pair', async () => {
      // Never registered: there is no private key to prove possession with, and
      // registration will link the session anyway.
      const server = createFakeServer()

      await ensureSessionBound(clientFor(server))

      expect(server.requests).toEqual([])
      expect(server.boundDeviceId).toBeNull()
    })

    it('binds once per credential, not once per call', async () => {
      const server = createFakeServer()
      storedKeyPair = await generateFullKeyPair()
      server.devicePublicKeys.set('test-device-id', {
        publicKey: await exportPublicKey(storedKeyPair.ecdhPublicKey),
        mlkemPublicKey: exportMlKemPublicKey(storedKeyPair.mlkemPublicKey),
      })
      const client = clientFor(server)

      await ensureSessionBound(client)
      const afterFirst = server.requests.length
      await ensureSessionBound(client)

      // App init and the session-change effect both call this; the second is a
      // no-op rather than a second handshake.
      expect(server.requests.length).toBe(afterFirst)

      // A new bearer means a new (unbound) session, so it binds again.
      localStorage.setItem(authTokenKey, 'a-fresh-session-token')
      await ensureSessionBound(client)
      expect(server.requests.length).toBeGreaterThan(afterFirst)
    })

    it('fails rather than binding when the challenge was sealed to another device', async () => {
      const server = createFakeServer()
      // A distinct bearer, because `ensureSessionBound` dedupes per token: the
      // successful bind above already recorded the shared `test-token`, and in
      // production a new session always means a new token.
      localStorage.setItem(authTokenKey, 'another-session-token')
      storedKeyPair = await generateFullKeyPair()
      const otherDevice = await generateFullKeyPair()
      // Server seals to a DIFFERENT device's public key — the shape of a server
      // (or attacker) trying to bind a session it does not own.
      server.devicePublicKeys.set('test-device-id', {
        publicKey: await exportPublicKey(otherDevice.ecdhPublicKey),
        mlkemPublicKey: exportMlKemPublicKey(otherDevice.mlkemPublicKey),
      })

      await expect(ensureSessionBound(clientFor(server))).rejects.toThrow()

      expect(server.boundDeviceId).toBeNull()
    })
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

  describe('org escrow (THU-804 / THU-866)', () => {
    const env = import.meta.env as Record<string, unknown>
    let savedPin: unknown

    beforeEach(() => {
      savedPin = env.VITE_ORG_ESCROW_PUBLIC_KEY
    })

    afterEach(() => {
      env.VITE_ORG_ESCROW_PUBLIC_KEY = savedPin
    })

    /** Pin a freshly minted operator escrow key into this build's env (THU-866). */
    const pinOrgEscrowKey = async (): Promise<void> => {
      const { publicKey } = await generateKeyPair()
      env.VITE_ORG_ESCROW_PUBLIC_KEY = await exportPublicKey(publicKey)
    }

    /**
     * A2 lying about escrow on the wire: enabled, with a key only the server
     * holds. The real route was deleted with THU-866, so this handler exists to
     * keep the assertion below non-vacuous — the fake server answers the old path
     * plausibly, and a pass means the client took its build-time pin and never
     * asked. If a client ever re-acquires that fetch, these tests fail.
     */
    const serveHostileOrgKey = async (server: FakeServer): Promise<void> => {
      const { publicKey } = await generateKeyPair()
      server.orgEscrow = { enabled: true, publicKey: await exportPublicKey(publicKey) }
    }

    /** The deleted route that used to drive the wrap target — no flow may request it. */
    const expectOrgKeyRouteUntouched = (server: FakeServer): void => {
      expect(server.requests).not.toContain('GET /encryption/org-key')
    }

    const makeAK = () => generateAK(true)

    it('buildOrgEnvelope escrows nothing when this build pins no key', async () => {
      env.VITE_ORG_ESCROW_PUBLIC_KEY = undefined
      expect(await buildOrgEnvelope(await makeAK())).toBeUndefined()
    })

    it('buildOrgEnvelope wraps the AK to the pinned key', async () => {
      await pinOrgEscrowKey()
      const envelope = await buildOrgEnvelope(await makeAK())
      expect(typeof envelope).toBe('string')
      expect(envelope!.length).toBeGreaterThan(0)
    })

    it('completeFirstDeviceSetup omits orgEnvelope when this build pins no key', async () => {
      const server = createFakeServer()
      await serveHostileOrgKey(server)
      env.VITE_ORG_ESCROW_PUBLIC_KEY = undefined
      storedKeyPair = await generateFullKeyPair()

      await completeFirstDeviceSetup(clientFor(server))

      // The escrow-DISABLED variant of THU-866: a deployment that configured no
      // escrow must not be talked into one by a server claiming escrow is on.
      expect(server.lastOrgEnvelope).toBeNull()
      expectOrgKeyRouteUntouched(server)
    })

    it('completeFirstDeviceSetup escrows to the pin while the server serves a hostile key', async () => {
      const server = createFakeServer()
      await pinOrgEscrowKey()
      await serveHostileOrgKey(server)
      storedKeyPair = await generateFullKeyPair()

      await completeFirstDeviceSetup(clientFor(server))

      expect(typeof server.lastOrgEnvelope).toBe('string')
      expectOrgKeyRouteUntouched(server)
    })

    it('rotateAccountKey escrows to the pin while the server serves a hostile key', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      await pinOrgEscrowKey()
      await serveHostileOrgKey(server)

      await rotateAccountKey(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(typeof server.lastOrgEnvelope).toBe('string')
      expectOrgKeyRouteUntouched(server)
    })

    it('migrateToV2 escrows to the pin while the server serves a hostile key', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV1Account(server, kp)
      await pinOrgEscrowKey()
      await serveHostileOrgKey(server)

      const result = await migrateToV2(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      expect(result.outcome).toBe('migrated')
      expect(typeof server.lastOrgEnvelope).toBe('string')
      expectOrgKeyRouteUntouched(server)
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

    it('refuses a steered primary key_id but still stages the keys (THU-876)', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      expect(storedPrimaryKeyId).toBe('0')

      // A2 points the primary at the decrypt-only legacy slot. Every DEK it
      // serves is honest and opens under our AK — only the pointer is a lie.
      server.metadata!.primaryKeyId = 'v1'
      server.metadata!.keyVersion += 1
      storedDEKs.clear()

      // `mockRestore` also clears the recorded calls, so collect them as they
      // happen rather than reading the spy afterwards.
      const errors: string[] = []
      const consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '))
      })
      try {
        await stageKeyring(clientFor(server))
      } finally {
        consoleError.mockRestore()
      }

      // The steer is refused, loudly, and the primary already in force survives...
      expect(storedPrimaryKeyId).toBe('0')
      expect(errors.some((line) => line.includes("refused a non-mintable primary key_id from the server: 'v1'"))).toBe(
        true,
      )
      // ...while the keys and the version still land. Refusing a pointer must
      // not cost the device its reads, which is why this is skip-and-log rather
      // than a throw: the DEKs are self-verifying, the pointer is not.
      expect([...storedDEKs.keys()].sort()).toEqual(['0', 'v1'])
      expect(storedKeyVersion).toBe(server.metadata!.keyVersion)
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

  /**
   * THU-869 — the AK envelope is ANONYMOUS: `wrapAK` needs only this device's
   * PUBLIC ECDH + ML-KEM keys, which the server stores. So a malicious server
   * mints an AK of its own, wraps it to those keys, and the device unwraps it
   * with its own private keys and cannot tell the sender changed. The defence is
   * a device-local witness to DEK "0"'s key material: DEK "0" is minted once per
   * account and every rotation re-wraps the SAME key, so a candidate AK that
   * cannot reproduce it is not this account's AK.
   */
  describe('inbound AK adoption (THU-869)', () => {
    /** A2 mints its own AK + DEK "0" and serves both, as a matching pair. */
    const substituteAKOnServer = async (server: FakeServer, kp: StoredKeyPair): Promise<CryptoKey> => {
      const attackerAK = await generateAK(true)
      for (const [keyId, wrapped] of [...server.wrappedKeys]) {
        void wrapped
        server.wrappedKeys.set(keyId, await wrapDEK(await generateDEK(true), attackerAK))
      }
      server.envelopes.set('test-device-id', await wrapAK(attackerAK, kp.ecdhPublicKey, kp.mlkemPublicKey))
      server.metadata!.keyVersion += 1
      return attackerAK
    }

    const establishedDevice = async (): Promise<{ server: FakeServer; kp: StoredKeyPair }> => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      return { server, kp }
    }

    it('mints a witness for an established device, from local state', async () => {
      await establishedDevice()

      expect(storedKeyringAnchor).not.toBeNull()
      expect(storedKeyringAnchor!.version).toBe(anchorVersion)
      // Bound to DEK "0"'s material, so it opens under the DEK "0" the local AK
      // yields — and under nothing else.
      const dek0 = await unwrapDEK(storedDEKs.get(initialKeyId)!, storedAK!)
      expect(await keyringAnchorOpens(storedKeyringAnchor!, dek0)).toBe(true)
    })

    it('refuses a substituted AK and keeps the keys already in force', async () => {
      const { server, kp } = await establishedDevice()
      const honestAK = storedAK
      const honestDEKs = new Map(storedDEKs)
      const honestVersion = storedKeyVersion

      const attackerAK = await substituteAKOnServer(server, kp)

      const errors: string[] = []
      const consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '))
      })
      try {
        await expect(refreshAK(clientFor(server))).rejects.toThrow(AKAnchorError)
      } finally {
        consoleError.mockRestore()
      }

      // Nothing was written: not the AK, not the keyring, not the version.
      expect(storedAK).toBe(honestAK)
      expect(storedAK).not.toBe(attackerAK)
      expect([...storedDEKs]).toEqual([...honestDEKs])
      expect(storedKeyVersion).toBe(honestVersion)
      expect(errors.some((line) => line.includes('refused an inbound account key (material-mismatch)'))).toBe(true)
    })

    it('still adopts a LEGITIMATELY rotated AK — the no-wedge property', async () => {
      const { server, kp } = await establishedDevice()
      const anchorBefore = storedKeyringAnchor

      // A real rotation elsewhere: the SAME DEKs re-wrapped under a new AK.
      const oldAK = await unwrapAK(server.envelopes.get('test-device-id')!, kp.ecdhPrivateKey, kp.mlkemSecretKey)
      const newAK = await generateAK(true)
      for (const [keyId, wrapped] of [...server.wrappedKeys]) {
        server.wrappedKeys.set(keyId, await wrapDEK(await unwrapDEK(wrapped, oldAK, true), newAK))
      }
      server.envelopes.set('test-device-id', await wrapAK(newAK, kp.ecdhPublicKey, kp.mlkemPublicKey))
      server.metadata!.keyVersion += 1

      await refreshAK(clientFor(server))

      // Adopted, keyring staged, and the witness untouched — a rotation changes
      // the wrapping, never DEK "0"'s material, which is why this passes.
      expect(await unwrapDEK(storedDEKs.get(initialKeyId)!, storedAK!).then(() => true)).toBe(true)
      expect(storedKeyVersion).toBe(server.metadata!.keyVersion)
      expect(storedKeyringAnchor).toBe(anchorBefore)
    })

    it('refuses when the server withholds key_id "0" from an established device', async () => {
      // The bypass that made the first draft of this fix a no-op: the check
      // skips when there is no witness, so a server that never serves DEK "0"
      // means no device ever mints one. Refusing turns that starvation from a
      // silent bypass into a denial of service.
      const { server, kp } = await establishedDevice()
      storedKeyringAnchor = null
      storedDEKs.delete(initialKeyId)
      await substituteAKOnServer(server, kp)
      server.wrappedKeys.delete(initialKeyId)

      const consoleError = spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(refreshAK(clientFor(server))).rejects.toThrow(/no-witness/)
      } finally {
        consoleError.mockRestore()
      }
    })

    it('does not rewrite a current witness when the served DEK "0" is relabelled', async () => {
      // AES-KW carries no key_id binding, so the server can serve an honest blob
      // for a DIFFERENT key under key_id "0". It unwraps fine under the local
      // AK, so a "re-mint whenever the witness disagrees with local state" rule
      // would quietly repoint the witness at a key the server chose. Write-once
      // is what makes that impossible.
      const { server, kp } = await establishedDevice()
      const anchorBefore = storedKeyringAnchor
      expect(anchorBefore).not.toBeNull()

      const ak = await unwrapAK(server.envelopes.get('test-device-id')!, kp.ecdhPrivateKey, kp.mlkemSecretKey)
      server.wrappedKeys.set(initialKeyId, await wrapDEK(await generateDEK(true), ak))
      server.metadata!.keyVersion += 1

      await stageKeyring(clientFor(server)).catch(() => undefined)

      expect(storedKeyringAnchor).toBe(anchorBefore)
    })

    it('re-mints only when the stored witness format is superseded', async () => {
      const { server } = await establishedDevice()
      const dek0 = await unwrapDEK(storedDEKs.get(initialKeyId)!, storedAK!)
      // A device carrying the previous on-disk format. It must re-mint from
      // local state rather than read as a substituted key, or an `anchorVersion`
      // bump would brick every device on every account.
      storedKeyringAnchor = { ...(await mintKeyringAnchor(dek0)), version: anchorVersion - 1 }

      await stageKeyring(clientFor(server))

      expect(storedKeyringAnchor!.version).toBe(anchorVersion)
      expect(await keyringAnchorOpens(storedKeyringAnchor!, dek0)).toBe(true)
    })

    it('leaves a brand-new device unverified — first adoption is trust-on-first-use', async () => {
      // A device with no AK and no witness shares no secret with the account and
      // its only channel is the adversary, so its FIRST key cannot be checked.
      // Pinned deliberately so the skip is never mistaken for an oversight.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      expect(storedAK).toBeNull()
      expect(storedKeyringAnchor).toBeNull()

      expect(await checkApprovalAndUnwrap(clientFor(server))).toBe(true)
      expect(storedAK).not.toBeNull()
      expect(storedKeyringAnchor).not.toBeNull()
    })

    it('reports a device that is not approved yet rather than treating it as tampering', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      server.envelopes.delete('test-device-id')

      expect(await checkApprovalAndUnwrap(clientFor(server))).toBe(false)
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

    /**
     * Pins the invariant every device's AK check depends on, at the only layer
     * that can break it. `assertRotateKeyCoverage` validates key_id SETS and
     * cannot see key material — the server holds no AK — so if a rotation ever
     * submitted FRESH material for `key_id "0"` the backend would accept it and
     * every established device on the account would refuse every future Account
     * Key, permanently and silently (THU-869). Nothing else would fail: not a
     * type, not the coverage check, not the rotation itself.
     */
    it('re-wraps DEK "0" rather than minting fresh material for it', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      const akBefore = storedAK!
      const rawBefore = await crypto.subtle.exportKey(
        'raw',
        await unwrapDEK(server.wrappedKeys.get(initialKeyId)!, akBefore, true),
      )

      await rotateAccountKey(clientFor(server), {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      // The wrapping changed; the key underneath did not.
      expect(server.wrappedKeys.get(initialKeyId)).not.toBe(undefined)
      expect(storedAK).not.toBe(akBefore)
      const rawAfter = await crypto.subtle.exportKey(
        'raw',
        await unwrapDEK(server.wrappedKeys.get(initialKeyId)!, storedAK!, true),
      )
      expect(uint8ArrayToBase64(new Uint8Array(rawAfter))).toBe(uint8ArrayToBase64(new Uint8Array(rawBefore)))
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

    // THU-865. A malicious server needs only to lie on GET /encryption/canary:
    // wrapping the new AK takes public keys alone, so a substituted recovery
    // keypair silently escrows the account to a phrase the attacker chose. The
    // attestation is verified against a signing key derived from LOCAL key
    // material, so the lie cannot be signed. Reproduced end to end by
    // e2e/e2ee/attacks/recovery-slot-substitution.spec.ts.
    it('aborts the re-anchor when the server substitutes the recovery public keys', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      const legit = { ...server.metadata! }

      const attackerKeyPair = await deriveRecoveryKeyPairFromSeed(generateRecoverySeed(), fixtureRecoverySalt)
      server.metadata!.recoveryEcdhPublicKey = await exportPublicKey(attackerKeyPair.ecdhPublicKey)
      server.metadata!.recoveryMlkemPublicKey = exportMlKemPublicKey(attackerKeyPair.mlkemPublicKey)

      await expect(
        rotateAccountKey(clientFor(server), {
          listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
        }),
      ).rejects.toThrow(RecoveryAnchorError)

      // Nothing was wrapped to the attacker: the rotation never reached the server.
      expect(server.metadata!.recoveryWrappedAk).toBe(legit.recoveryWrappedAk)
      expect(server.metadata!.keyVersion).toBe(legit.keyVersion)
    })

    it('aborts the re-anchor when the served anchor carries no attestation', async () => {
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))
      // Fail closed rather than adopting an unverifiable anchor — an account row
      // predating the attestation column re-anchors via changeRecoveryPhrase.
      server.metadata!.recoveryAttestation = null

      await expect(
        rotateAccountKey(clientFor(server), {
          listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
        }),
      ).rejects.toThrow(RecoveryAnchorError)
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

    it('ignores a planted out-of-grammar key_id when allocating the new primary (THU-871)', async () => {
      // THE collision. A 17-digit key_id makes `max + 1 === max` under IEEE-754,
      // so the unfiltered allocator handed back the attacker's own id: the
      // server discarded the freshly minted DEK (ON CONFLICT DO NOTHING),
      // reported success, and moved the primary onto a row nobody holds the key
      // for — bricking every future write, permanently, because each later
      // rotation recomputed the same id. Filtering candidates through
      // `keyIdPattern` makes the planted row inert.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      // Carries a byte-copy of DEK '0's wrapping, so the row OPENS under the AK
      // and the re-wrap succeeds — isolating the collision from the separate
      // poison-pill defect that an unopenable row triggers.
      const planted = '10000000000000000'
      expect(String(Number.parseInt(planted, 10) + 1)).toBe(planted) // the arithmetic really does collide
      const dek0Wrapping = server.wrappedKeys.get(initialKeyId)!
      server.wrappedKeys.set(planted, dek0Wrapping)

      await revokeDeviceAndRotate(clientFor(server), 'other-device', {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      // Allocated past the real counter, not onto the planted row, and the
      // primary points at a key this device actually minted.
      expect(server.metadata?.primaryKeyId).toBe('1')
      expect(server.wrappedKeys.has(planted)).toBe(true)
      expect(await unwrapDEK(server.wrappedKeys.get('1')!, storedAK!)).toBeDefined()
    })

    it('is not blocked by a planted key_id at the top of the grammar (THU-871)', async () => {
      // The boundary case that highest-plus-one left open. `'9'.repeat(15)` is
      // itself grammar-valid, so filtering could not ignore it, and `max + 1`
      // produced a 16-digit id the server's own mint validation rejects — every
      // revocation then failed as "retry" forever. Allocating the smallest hole
      // instead steps over the planted row entirely.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      const planted = '9'.repeat(15)
      server.wrappedKeys.set(planted, server.wrappedKeys.get(initialKeyId)!)

      await revokeDeviceAndRotate(clientFor(server), 'other-device', {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      // Allocated into the gap, well inside the grammar the server enforces.
      expect(server.metadata?.primaryKeyId).toBe('1')
      expect(isMintableKeyId(server.metadata!.primaryKeyId)).toBe(true)
      expect(await unwrapDEK(server.wrappedKeys.get('1')!, storedAK!)).toBeDefined()
    })

    it('completes despite an unopenable keyring row, passing it through (THU-871)', async () => {
      // The poison-pill. One junk row used to throw inside `rewrapKeyring`, and
      // because revocation IS an AK rotation that permanently killed
      // cryptographic revocation AND "Change Recovery Phrase" for the account.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      await seedV2Account(server, kp, await generateDEK(true))
      await checkApprovalAndUnwrap(clientFor(server))

      // Wrapped under an AK nobody on this account holds.
      const junk = await wrapDEK(await generateDEK(true), await generateAK(true))
      server.wrappedKeys.set('poison', junk)
      const versionBefore = server.metadata!.keyVersion

      await revokeDeviceAndRotate(clientFor(server), 'other-device', {
        listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
      })

      // The rotation went through: version bumped, a new primary was minted, and
      // the real keys moved to the new AK.
      expect(server.metadata!.keyVersion).toBe(versionBefore + 1)
      expect(server.metadata!.primaryKeyId).toBe('1')
      expect(await unwrapDEK(server.wrappedKeys.get(initialKeyId)!, storedAK!)).toBeDefined()
      // The junk row kept its original blob — passed through, not dropped and not
      // deleted, so it remains repairable by a device holding the old AK.
      expect(server.wrappedKeys.get('poison')).toBe(junk)
    })

    it('leaves the previous phrase valid AND mints nothing when the rotation fails', async () => {
      // Regression, in two parts. The phrase half: the DEK rotation used to run
      // AFTER the AK rotation, so a failure invalidated the old phrase while the
      // new one was never returned — leaving the account with a phrase nobody
      // knows. The keyring half (THU-871): the DEK mint used to be its own
      // request, so a failed rotation still left a new row behind and every
      // retry added another one, ratcheting the keyring toward the size at
      // which no rotation fits. Folded into /encryption/rotate, one failure
      // leaves both untouched.
      const server = createFakeServer()
      const kp = await generateFullKeyPair()
      storedKeyPair = kp
      const originalPhrase = await completeFirstDeviceSetup(clientFor(server))
      const saltBefore = server.metadata!.kdfSalt
      const keyIdsBefore = [...server.wrappedKeys.keys()]
      server.rotateStatus = 500

      // Retried the way the UI asks the user to, to pin that it does not ratchet.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          revokeDeviceAndRotate(clientFor(server), 'other-device', {
            listTrustedDevices: async () => [await deviceKeysFor(kp, 'test-device-id')],
          }),
        ).rejects.toThrow()
      }

      expect([...server.wrappedKeys.keys()]).toEqual(keyIdsBefore)
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
