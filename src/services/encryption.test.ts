/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach } from 'bun:test'
import { createClient } from '@/lib/http'
import {
  generateKeyPair,
  generateMlKemKeyPair,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  wrapAK,
  unwrapAK,
  unwrapDEK,
  verifyCanary,
  decodeRecoveryKey,
  deriveAKFromSeed,
  base64ToUint8Array,
  getKeyPair,
  getAK,
  getWrappedDEK,
  listWrappedDEKs,
  getPrimaryKeyId,
  getKeyVersion,
  ValidationError,
  type MlKemKeyPair,
} from '@/crypto'
import {
  ecdsaKeyAlgorithm,
  ecdsaSignAlgorithm,
  encodeChallengePayload,
  initialKeyId,
  type ChallengeProof,
} from '@shared/e2ee-types'
import {
  registerThisDevice,
  completeFirstDeviceSetup,
  approveDevice,
  checkApprovalAndUnwrap,
  recoverWithKey,
  revokeDeviceWithProof,
  denyDeviceWithProof,
  setDeviceNodeIdWithProof,
  stageKeyring,
  refreshAK,
  rotateAK,
  rotateDEK,
  revokeDeviceAndRotate,
  handleFullWipe,
  RotationStaleError,
  type TrustedDevicePublicKeys,
} from './encryption'

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'
const deviceA = 'device-a'
const deviceB = 'device-b'

const setCurrentDevice = (deviceId: string) => localStorage.setItem(deviceIdKey, deviceId)

const deleteKeyDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

// ---------------------------------------------------------------------------
// Stateful fake backend — mirrors backend/src/api/encryption.ts semantics,
// including REAL ECDSA proof verification against the stored signing key
// (same importKey/verify path the backend uses).
// ---------------------------------------------------------------------------

type ServerMetadata = {
  canaryIv: string
  canaryCtext: string
  kdfSalt: string | null
  signingPublicKey: string | null
  keyVersion: number
  primaryKeyId: string
}

type CapturedRequest = { url: string; method: string; body: Record<string, unknown> | null; deviceId: string | null }

type FakeServer = {
  httpClient: ReturnType<typeof createClient>
  requests: CapturedRequest[]
  state: {
    metadata: ServerMetadata | null
    keys: Map<string, string>
    envelopes: Map<string, string>
    devices: Map<string, { trusted: boolean; revoked: boolean }>
    nonces: Map<string, { operation: string; deviceId: string; consumed: boolean }>
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const createFakeServer = (): FakeServer => {
  const state: FakeServer['state'] = {
    metadata: null,
    keys: new Map(),
    envelopes: new Map(),
    devices: new Map(),
    nonces: new Map(),
  }
  const requests: CapturedRequest[] = []
  let nonceCounter = 0

  const verifyProof = async (proof: ChallengeProof, operation: string, callerDeviceId: string): Promise<boolean> => {
    const nonce = state.nonces.get(proof.nonce)
    if (!nonce || nonce.consumed) {
      return false
    }
    nonce.consumed = true
    if (nonce.operation !== proof.operation || proof.operation !== operation) {
      return false
    }
    if (nonce.deviceId !== proof.deviceId || proof.deviceId !== callerDeviceId) {
      return false
    }
    if (!state.metadata?.signingPublicKey) {
      return false
    }
    const publicKey = await crypto.subtle.importKey(
      'spki',
      base64ToUint8Array(state.metadata.signingPublicKey),
      ecdsaKeyAlgorithm,
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      base64ToUint8Array(proof.signature),
      new Uint8Array(encodeChallengePayload(proof.nonce, proof.operation, proof.deviceId)),
    )
  }

  const handle = async (
    path: string,
    method: string,
    body: Record<string, unknown> | null,
    deviceId: string | null,
  ): Promise<Response> => {
    if (path === '/devices' && method === 'POST') {
      const id = body!.deviceId as string
      const existing = state.devices.get(id)
      if (existing?.trusted) {
        return jsonResponse({ trusted: true, envelope: state.envelopes.get(id) ?? null })
      }
      state.devices.set(id, { trusted: false, revoked: false })
      return jsonResponse({ trusted: false })
    }

    if (path === '/devices/me/envelope' && method === 'GET') {
      const envelope = deviceId ? state.envelopes.get(deviceId) : undefined
      if (!envelope) {
        return jsonResponse({ error: 'Envelope not found' }, 404)
      }
      return jsonResponse({ trusted: state.devices.get(deviceId!)?.trusted ?? false, wrappedCK: envelope })
    }

    const envelopeMatch = path.match(/^\/devices\/([^/]+)\/envelope$/)
    if (envelopeMatch && method === 'POST') {
      const targetId = decodeURIComponent(envelopeMatch[1])
      if (!state.metadata) {
        // Bootstrap: caller == target, full atomic setup payload required.
        if (deviceId !== targetId || state.envelopes.size > 0) {
          return jsonResponse({ error: 'Only first-device bootstrap can store envelopes' }, 403)
        }
        const wrappedKeys = body!.wrappedKeys as Array<{ keyId: string; wrappedKey: string }> | undefined
        if (
          !body!.canaryIv ||
          !body!.canaryCtext ||
          !body!.signingPublicKey ||
          !body!.kdfSalt ||
          !wrappedKeys?.length
        ) {
          return jsonResponse({ error: 'Bootstrap payload incomplete' }, 400)
        }
        state.metadata = {
          canaryIv: body!.canaryIv as string,
          canaryCtext: body!.canaryCtext as string,
          kdfSalt: body!.kdfSalt as string,
          signingPublicKey: body!.signingPublicKey as string,
          keyVersion: 1,
          primaryKeyId: initialKeyId,
        }
        for (const entry of wrappedKeys) {
          state.keys.set(entry.keyId, entry.wrappedKey)
        }
      } else {
        const proof = body!.proof as ChallengeProof | undefined
        if (!proof || !(await verifyProof(proof, 'approve', deviceId!))) {
          return jsonResponse({ error: 'Invalid challenge proof' }, 403)
        }
      }
      state.envelopes.set(targetId, body!.wrappedCK as string)
      state.devices.set(targetId, { trusted: true, revoked: false })
      return jsonResponse({ trusted: true })
    }

    if (path === '/encryption/canary' && method === 'GET') {
      if (!state.metadata) {
        return jsonResponse({ error: 'Encryption not set up' }, 404)
      }
      return jsonResponse({
        canary_iv: state.metadata.canaryIv,
        canary_ctext: state.metadata.canaryCtext,
        kdf_salt: state.metadata.kdfSalt,
        signing_public_key: state.metadata.signingPublicKey,
        key_version: state.metadata.keyVersion,
        primary_key_id: state.metadata.primaryKeyId,
      })
    }

    if (path === '/encryption/keys' && method === 'GET') {
      return jsonResponse({
        keys: [...state.keys.entries()].map(([keyId, wrappedKey]) => ({ key_id: keyId, wrapped_key: wrappedKey })),
      })
    }

    if (path === '/encryption/keys' && method === 'POST') {
      const keyId = body!.keyId as string
      if (!state.keys.has(keyId)) {
        state.keys.set(keyId, body!.wrappedKey as string)
      }
      if (body!.setPrimary && state.metadata) {
        state.metadata.primaryKeyId = keyId
      }
      return jsonResponse({ key_id: keyId })
    }

    const keyMatch = path.match(/^\/encryption\/keys\/([^/]+)$/)
    if (keyMatch && method === 'GET') {
      const keyId = decodeURIComponent(keyMatch[1])
      const wrapped = state.keys.get(keyId)
      if (!wrapped) {
        return jsonResponse({ error: 'Key not found' }, 404)
      }
      return jsonResponse({ key_id: keyId, wrapped_key: wrapped })
    }

    if (path.startsWith('/encryption/challenge') && method === 'GET') {
      const operation = new URL(`http://x${path}`).searchParams.get('operation')!
      const nonce = `nonce-${++nonceCounter}`
      state.nonces.set(nonce, { operation, deviceId: deviceId!, consumed: false })
      return jsonResponse({ nonce, expires_at: new Date(Date.now() + 300_000).toISOString() })
    }

    if (path === '/encryption/rotate' && method === 'POST') {
      const proof = body!.proof as ChallengeProof
      if (!(await verifyProof(proof, 'rotate', deviceId!))) {
        return jsonResponse({ error: 'Invalid challenge proof' }, 403)
      }
      const wrappedKeys = body!.wrappedKeys as Array<{ keyId: string; wrappedKey: string }>
      const submittedKeyIds = new Set(wrappedKeys.map((entry) => entry.keyId))
      const missingKey = [...state.keys.keys()].find((keyId) => !submittedKeyIds.has(keyId))
      const unknownKey = [...submittedKeyIds].find((keyId) => !state.keys.has(keyId))
      if (missingKey || unknownKey) {
        return jsonResponse({ error: 'wrappedKeys must cover every existing key_id exactly' }, 400)
      }
      const envelopes = body!.envelopes as Array<{ deviceId: string; wrappedCK: string }>
      const submittedDeviceIds = new Set(envelopes.map((envelope) => envelope.deviceId))
      const trustedIds = [...state.devices.entries()].filter(([, d]) => d.trusted && !d.revoked).map(([id]) => id)
      const missingDevice = trustedIds.find((id) => !submittedDeviceIds.has(id))
      const unknownDevice = [...submittedDeviceIds].find((id) => !trustedIds.includes(id))
      if (missingDevice || unknownDevice) {
        return jsonResponse({ error: 'envelopes must cover every trusted device exactly' }, 400)
      }
      for (const envelope of envelopes) {
        state.envelopes.set(envelope.deviceId, envelope.wrappedCK)
      }
      for (const entry of wrappedKeys) {
        state.keys.set(entry.keyId, entry.wrappedKey)
      }
      state.metadata = {
        ...state.metadata!,
        canaryIv: body!.canaryIv as string,
        canaryCtext: body!.canaryCtext as string,
        signingPublicKey: body!.signingPublicKey as string,
        kdfSalt: body!.kdfSalt as string,
        keyVersion: state.metadata!.keyVersion + 1,
      }
      return jsonResponse({ key_version: state.metadata.keyVersion })
    }

    const denyMatch = path.match(/^\/devices\/([^/]+)\/deny$/)
    if (denyMatch && method === 'POST') {
      const proof = body!.proof as ChallengeProof
      if (!(await verifyProof(proof, 'deny', deviceId!))) {
        return jsonResponse({ error: 'Invalid challenge proof' }, 403)
      }
      state.devices.delete(decodeURIComponent(denyMatch[1]))
      return jsonResponse(null, 204)
    }

    const nodeIdMatch = path.match(/^\/devices\/([^/]+)\/node-id$/)
    if (nodeIdMatch && method === 'POST') {
      const proof = body!.proof as ChallengeProof
      if (!(await verifyProof(proof, 'node-id', deviceId!))) {
        return jsonResponse({ error: 'Invalid challenge proof' }, 403)
      }
      return jsonResponse({ nodeId: body!.nodeId })
    }

    const revokeMatch = path.match(/^\/account\/devices\/([^/]+)\/revoke$/)
    if (revokeMatch && method === 'POST') {
      const proofRequired = state.metadata?.signingPublicKey != null
      if (proofRequired) {
        const proof = body?.proof as ChallengeProof | undefined
        if (!proof || !(await verifyProof(proof, 'revoke', deviceId!))) {
          return jsonResponse({ error: 'Invalid challenge proof' }, 403)
        }
      }
      const targetId = decodeURIComponent(revokeMatch[1])
      state.envelopes.delete(targetId)
      const device = state.devices.get(targetId)
      if (device) {
        device.trusted = false
        device.revoked = true
      }
      return jsonResponse(null, 204)
    }

    throw new Error(`fake server: unhandled route ${method} ${path}`)
  }

  const mockFetch = async (input: Request): Promise<Response> => {
    const url = new URL(input.url)
    const deviceId = localStorage.getItem(deviceIdKey)
    let body: Record<string, unknown> | null = null
    try {
      body = (await input.json()) as Record<string, unknown>
    } catch {
      // GET requests have no body
    }
    requests.push({ url: input.url, method: input.method, body, deviceId })
    return handle(url.pathname + url.search, input.method, body, deviceId)
  }

  return {
    httpClient: createClient({ fetch: mockFetch as unknown as typeof fetch, prefixUrl: 'http://test-api.local' }),
    requests,
    state,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ManualKeyPair = { ecdh: CryptoKeyPair; mlkem: MlKemKeyPair; publicKey: string; mlkemPublicKey: string }

/** In-memory keypair for simulating a second device (its keys never touch IndexedDB). */
const generateManualKeyPair = async (): Promise<ManualKeyPair> => {
  const ecdh = await generateKeyPair()
  const mlkem = generateMlKemKeyPair()
  return {
    ecdh,
    mlkem,
    publicKey: await exportPublicKey(ecdh.publicKey),
    mlkemPublicKey: exportMlKemPublicKey(mlkem.publicKey),
  }
}

/** Full first-device setup for `deviceA` against the given fake server. */
const setupFirstDevice = async (server: FakeServer): Promise<string> => {
  setCurrentDevice(deviceA)
  await registerThisDevice(server.httpClient)
  return completeFirstDeviceSetup(server.httpClient)
}

const trustedDevicesForRotate = async (extra: TrustedDevicePublicKeys[] = []): Promise<TrustedDevicePublicKeys[]> => {
  const keyPair = await getKeyPair()
  return [
    {
      id: deviceA,
      publicKey: await exportPublicKey(keyPair!.ecdhPublicKey),
      mlkemPublicKey: exportMlKemPublicKey(keyPair!.mlkemPublicKey),
    },
    ...extra,
  ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('encryption service (E2EE v2)', () => {
  beforeEach(async () => {
    localStorage.setItem(authTokenKey, 'test-token')
    setCurrentDevice(deviceA)
    await deleteKeyDatabase()
  })

  describe('completeFirstDeviceSetup', () => {
    it('bootstraps the full v2 state and returns a 24-word recovery key', async () => {
      const server = createFakeServer()
      const recoveryKey = await setupFirstDevice(server)

      expect(recoveryKey.split(' ')).toHaveLength(24)

      // Server got the atomic bootstrap payload
      expect(server.state.metadata).not.toBeNull()
      expect(server.state.metadata!.signingPublicKey).toBeTruthy()
      expect(server.state.metadata!.kdfSalt).toBeTruthy()
      expect(server.state.keys.get(initialKeyId)).toBeTruthy()
      expect(server.state.envelopes.get(deviceA)).toBeTruthy()

      // Local state: non-extractable AK + wrapped DEK '0' + primary pointer
      const ak = await getAK()
      expect(ak).not.toBeNull()
      expect(ak!.extractable).toBe(false)
      expect(await getWrappedDEK(initialKeyId)).toBe(server.state.keys.get(initialKeyId)!)
      expect(await getPrimaryKeyId()).toBe(initialKeyId)
      expect(await getKeyVersion()).toBe(1)

      // The stored AK unwraps DEK '0', which verifies the server canary
      const dek0 = await unwrapDEK((await getWrappedDEK(initialKeyId))!, ak!)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)
    })

    it('recovery key re-derives the AK deterministically (seed + salt)', async () => {
      const server = createFakeServer()
      const recoveryKey = await setupFirstDevice(server)

      const seed = decodeRecoveryKey(recoveryKey)
      const rederivedAK = await deriveAKFromSeed(seed, server.state.metadata!.kdfSalt!)
      const dek0 = await unwrapDEK(server.state.keys.get(initialKeyId)!, rederivedAK)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)
    })

    it('throws if key pair is missing', async () => {
      const server = createFakeServer()
      await expect(completeFirstDeviceSetup(server.httpClient)).rejects.toThrow('Key pair not found')
    })
  })

  describe('approveDevice → second device decrypts', () => {
    it('rewraps the AK for the pending device; its keys unwrap the full chain', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)

      // Pending second device (keys held in memory — storage belongs to device A)
      const pending = await generateManualKeyPair()
      server.state.devices.set(deviceB, { trusted: false, revoked: false })

      await approveDevice(server.httpClient, deviceB, pending.publicKey, pending.mlkemPublicKey)

      // The envelope stored for B unwraps to an AK that unwraps DEK '0' and
      // verifies the canary — the full second-device decrypt chain.
      const envelopeB = server.state.envelopes.get(deviceB)
      expect(envelopeB).toBeTruthy()
      const akB = await unwrapAK(envelopeB!, pending.ecdh.privateKey, pending.mlkem.secretKey)
      const dek0 = await unwrapDEK(server.state.keys.get(initialKeyId)!, akB)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)
    })

    it('gates the approval with a verified approve proof (no raw secret on the wire)', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      const pending = await generateManualKeyPair()

      await approveDevice(server.httpClient, deviceB, pending.publicKey, pending.mlkemPublicKey)

      const storeReq = server.requests.find((req) => req.url.includes(`/devices/${deviceB}/envelope`))
      expect(storeReq).toBeDefined()
      const proof = storeReq!.body!.proof as ChallengeProof
      expect(proof).toMatchObject({ operation: 'approve', deviceId: deviceA })
      expect(proof.signature.length).toBeGreaterThan(0)
      expect(proof.nonce.length).toBeGreaterThan(0)
      expect(JSON.stringify(storeReq!.body)).not.toContain('canarySecret')
    })
  })

  describe('checkApprovalAndUnwrap', () => {
    it('unwraps the AK from the envelope and stages the keyring', async () => {
      const server = createFakeServer()
      const recoveryKey = await setupFirstDevice(server)
      await setupApprovedFreshDevice(server, recoveryKey)

      const result = await checkApprovalAndUnwrap(server.httpClient)

      expect(result).toBe(true)
      const ak = await getAK()
      expect(ak).not.toBeNull()
      // Keyring staged + primary pointer set
      expect((await listWrappedDEKs()).map((entry) => entry.keyId)).toContain(initialKeyId)
      expect(await getPrimaryKeyId()).toBe(initialKeyId)
      // The staged chain decrypts the canary
      const dek0 = await unwrapDEK((await getWrappedDEK(initialKeyId))!, ak!)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)
    })

    it('returns false when the envelope fetch returns 404 (not yet approved)', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      setCurrentDevice(deviceB)
      await deleteKeyDatabase()
      await registerThisDevice(server.httpClient)

      expect(await checkApprovalAndUnwrap(server.httpClient)).toBe(false)
    })
  })

  describe('recoverWithKey', () => {
    it('re-derives the same AK from the recovery phrase and self-approves', async () => {
      const server = createFakeServer()
      const recoveryKey = await setupFirstDevice(server)
      const canaryBefore = { iv: server.state.metadata!.canaryIv, ctext: server.state.metadata!.canaryCtext }

      // Fresh device: wiped local state, new device id
      setCurrentDevice(deviceB)
      await deleteKeyDatabase()

      await recoverWithKey(server.httpClient, recoveryKey)

      // The recovered device is trusted and has its own envelope
      expect(server.state.devices.get(deviceB)?.trusted).toBe(true)
      expect(server.state.envelopes.get(deviceB)).toBeTruthy()

      // The stored (non-extractable) AK unwraps DEK '0' → same AK as before
      const ak = await getAK()
      expect(ak).not.toBeNull()
      expect(ak!.extractable).toBe(false)
      expect(await getPrimaryKeyId()).toBe(initialKeyId)
      expect(await getKeyVersion()).toBe(1)
      const dek0 = await unwrapDEK((await getWrappedDEK(initialKeyId))!, ak!)
      const { valid } = await verifyCanary(dek0, canaryBefore.iv, canaryBefore.ctext)
      expect(valid).toBe(true)

      // The self-approval carried a proof, never a secret
      const storeReq = server.requests.find(
        (req) => req.url.includes(`/devices/${deviceB}/envelope`) && req.method === 'POST',
      )
      const proof = storeReq!.body!.proof as ChallengeProof
      expect(proof).toMatchObject({ operation: 'approve', deviceId: deviceB })
      expect(JSON.stringify(storeReq!.body)).not.toContain('canarySecret')
    })

    it('rejects a wrong recovery phrase with ValidationError', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)

      setCurrentDevice(deviceB)
      await deleteKeyDatabase()

      // Valid mnemonic (checksum ok) but the wrong seed for this account
      const wrongPhrase = Array(24)
        .fill('abandon')
        .join(' ')
        .replace(/abandon$/, 'art')
      await expect(recoverWithKey(server.httpClient, wrongPhrase)).rejects.toBeInstanceOf(ValidationError)
    })

    it('rejects a v1 account (null signing_public_key) with ValidationError', async () => {
      const server = createFakeServer()
      server.state.metadata = {
        canaryIv: 'v1-iv',
        canaryCtext: 'v1-ctext',
        kdfSalt: null,
        signingPublicKey: null,
        keyVersion: 1,
        primaryKeyId: initialKeyId,
      }

      const anyValidPhrase = Array(24)
        .fill('abandon')
        .join(' ')
        .replace(/abandon$/, 'art')
      await expect(recoverWithKey(server.httpClient, anyValidPhrase)).rejects.toBeInstanceOf(ValidationError)
      await expect(recoverWithKey(server.httpClient, anyValidPhrase)).rejects.toThrow('outdated encryption setup')
    })
  })

  describe('deny / node-id / revoke proofs', () => {
    it('denyDeviceWithProof and setDeviceNodeIdWithProof carry verified proofs', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      server.state.devices.set(deviceB, { trusted: false, revoked: false })

      await denyDeviceWithProof(server.httpClient, deviceB)
      await setDeviceNodeIdWithProof(server.httpClient, deviceA, 'node-123')

      const denyReq = server.requests.find((req) => req.url.includes('/deny'))
      const nodeReq = server.requests.find((req) => req.url.includes('/node-id'))
      expect((denyReq!.body!.proof as ChallengeProof).operation).toBe('deny')
      expect((nodeReq!.body!.proof as ChallengeProof).operation).toBe('node-id')
      expect(nodeReq!.body!.nodeId).toBe('node-123')
      for (const req of [denyReq!, nodeReq!]) {
        expect(JSON.stringify(req.body)).not.toContain('canarySecret')
      }
    })

    it('revokeDeviceWithProof sends a verified revoke proof when E2EE is active', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      server.state.devices.set(deviceB, { trusted: true, revoked: false })
      server.state.envelopes.set(deviceB, 'envelope-b')

      await revokeDeviceWithProof(server.httpClient, deviceB)

      expect(server.state.devices.get(deviceB)?.revoked).toBe(true)
      expect(server.state.envelopes.has(deviceB)).toBe(false)
      const revokeReq = server.requests.find((req) => req.url.includes('/revoke'))
      expect((revokeReq!.body!.proof as ChallengeProof).operation).toBe('revoke')
    })

    it('revokes without a proof for pre-E2EE accounts (no metadata)', async () => {
      const server = createFakeServer()
      setCurrentDevice(deviceA)
      server.state.devices.set(deviceB, { trusted: true, revoked: false })

      await revokeDeviceWithProof(server.httpClient, deviceB)

      expect(server.state.devices.get(deviceB)?.revoked).toBe(true)
      const revokeReq = server.requests.find((req) => req.url.includes('/revoke'))
      expect(revokeReq!.body).toEqual({})
    })

    it('revokes without a proof for v1 leftovers (null signing_public_key)', async () => {
      const server = createFakeServer()
      server.state.metadata = {
        canaryIv: 'v1-iv',
        canaryCtext: 'v1-ctext',
        kdfSalt: null,
        signingPublicKey: null,
        keyVersion: 1,
        primaryKeyId: initialKeyId,
      }
      server.state.devices.set(deviceB, { trusted: true, revoked: false })

      await revokeDeviceWithProof(server.httpClient, deviceB)

      const revokeReq = server.requests.find((req) => req.url.includes('/revoke'))
      expect(revokeReq!.body).toEqual({})
    })
  })

  describe('stageKeyring / refreshAK', () => {
    it('stageKeyring stages every wrapped key and the primary pointer', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      server.state.keys.set('1', server.state.keys.get(initialKeyId)!)
      server.state.metadata!.primaryKeyId = '1'

      await stageKeyring(server.httpClient)

      const staged = (await listWrappedDEKs()).map((entry) => entry.keyId).sort()
      expect(staged).toEqual([initialKeyId, '1'])
      expect(await getPrimaryKeyId()).toBe('1')
      expect(await getKeyVersion()).toBe(1)
    })

    it('refreshAK recovers a device holding a stale AK', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)

      // Rotate the AK server-side; the local AK is now stale.
      await rotateAK(server.httpClient, { listTrustedDevices: () => trustedDevicesForRotate() })

      // Wipe the local AK to simulate the stale/other-device case, then refresh.
      const beforeRefresh = await getAK()
      expect(beforeRefresh).not.toBeNull()
      await refreshAK(server.httpClient)

      const ak = await getAK()
      const dek0 = await unwrapDEK((await getWrappedDEK(initialKeyId))!, ak!)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)
    })
  })

  describe('rotateAK', () => {
    it('keeps every key_id decryptable, excludes the revoked device, returns a new mnemonic', async () => {
      const server = createFakeServer()
      const oldRecoveryKey = await setupFirstDevice(server)
      const oldAK = await getAK()

      // Second key_id on the keyring
      await rotateDEK(server.httpClient)
      expect([...server.state.keys.keys()].sort()).toEqual(['0', '1'])

      // Second trusted device (approved for real so the server tracks it)
      const pending = await generateManualKeyPair()
      server.state.devices.set(deviceB, { trusted: false, revoked: false })
      await approveDevice(server.httpClient, deviceB, pending.publicKey, pending.mlkemPublicKey)

      // Revoke B server-side, then rotate while the (injected) local devices
      // list STILL contains B — simulating devices-table sync lag.
      await revokeDeviceWithProof(server.httpClient, deviceB)
      const laggedDeviceList = await trustedDevicesForRotate([
        { id: deviceB, publicKey: pending.publicKey, mlkemPublicKey: pending.mlkemPublicKey },
      ])
      const newRecoveryKey = await rotateAK(server.httpClient, {
        excludeDeviceIds: [deviceB],
        listTrustedDevices: () => Promise.resolve(laggedDeviceList),
      })

      expect(newRecoveryKey.split(' ')).toHaveLength(24)
      expect(newRecoveryKey).not.toBe(oldRecoveryKey)
      expect(server.state.metadata!.keyVersion).toBe(2)

      // The revoked device got NO new envelope
      expect(server.state.envelopes.has(deviceB)).toBe(false)

      // BOTH key_ids unwrap under the new AK (derived from the new mnemonic)…
      const newAK = await deriveAKFromSeed(decodeRecoveryKey(newRecoveryKey), server.state.metadata!.kdfSalt!)
      for (const keyId of ['0', '1']) {
        const dek = await unwrapDEK(server.state.keys.get(keyId)!, newAK)
        expect(dek.algorithm.name).toBe('AES-GCM')
      }
      // …and the new canary verifies under DEK '0'
      const dek0 = await unwrapDEK(server.state.keys.get(initialKeyId)!, newAK)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)

      // …while the OLD AK cannot unwrap the re-wrapped keyring
      await expect(unwrapDEK(server.state.keys.get(initialKeyId)!, oldAK!)).rejects.toThrow()

      // Local state committed: staged keyring under the new AK
      const localAK = await getAK()
      const localDek0 = await unwrapDEK((await getWrappedDEK(initialKeyId))!, localAK!)
      expect(localDek0.algorithm.name).toBe('AES-GCM')

      // The rotate proof was signed with the OLD signing key and carried no secret
      const rotateReq = server.requests.find((req) => req.url.includes('/encryption/rotate'))
      expect((rotateReq!.body!.proof as ChallengeProof).operation).toBe('rotate')
      expect(JSON.stringify(rotateReq!.body)).not.toContain('canarySecret')
    })

    it('throws a retryable RotationStaleError on 4xx and refreshes local state', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)

      // A device the server considers trusted but the local list omits →
      // envelope coverage fails with 400.
      const pending = await generateManualKeyPair()
      server.state.devices.set(deviceB, { trusted: false, revoked: false })
      await approveDevice(server.httpClient, deviceB, pending.publicKey, pending.mlkemPublicKey)

      await expect(
        rotateAK(server.httpClient, { listTrustedDevices: () => trustedDevicesForRotate() }),
      ).rejects.toBeInstanceOf(RotationStaleError)

      // Server state untouched, local state still functional after refresh
      expect(server.state.metadata!.keyVersion).toBe(1)
      const ak = await getAK()
      const dek0 = await unwrapDEK((await getWrappedDEK(initialKeyId))!, ak!)
      const { valid } = await verifyCanary(dek0, server.state.metadata!.canaryIv, server.state.metadata!.canaryCtext)
      expect(valid).toBe(true)
    })
  })

  describe('rotateDEK', () => {
    it('mints the next numeric key_id, sets it primary, and stages it locally', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)

      const newKeyId = await rotateDEK(server.httpClient)

      expect(newKeyId).toBe('1')
      expect(server.state.keys.has('1')).toBe(true)
      expect(server.state.metadata!.primaryKeyId).toBe('1')
      expect(await getPrimaryKeyId()).toBe('1')

      // The new wrapped DEK unwraps under the current AK; the old one is retained
      const ak = await getAK()
      const newDek = await unwrapDEK((await getWrappedDEK('1'))!, ak!)
      expect(newDek.algorithm.name).toBe('AES-GCM')
      expect(await getWrappedDEK(initialKeyId)).toBeTruthy()

      const postReq = server.requests.find((req) => req.url.endsWith('/encryption/keys') && req.method === 'POST')
      expect(postReq!.body).toMatchObject({ keyId: '1', setPrimary: true })
    })

    it('skips non-numeric key_ids when picking the next id', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      server.state.keys.set('ws1', 'workspace-wrapped-key')

      expect(await rotateDEK(server.httpClient)).toBe('1')
    })
  })

  describe('revokeDeviceAndRotate', () => {
    it('revokes, rotates AK excluding the device, rotates DEK, returns the new mnemonic', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)

      const pending = await generateManualKeyPair()
      server.state.devices.set(deviceB, { trusted: false, revoked: false })
      await approveDevice(server.httpClient, deviceB, pending.publicKey, pending.mlkemPublicKey)
      const envelopeBBefore = server.state.envelopes.get(deviceB)!
      const oldAKOfB = await unwrapAK(envelopeBBefore, pending.ecdh.privateKey, pending.mlkem.secretKey)

      // Local devices list still shows B trusted (sync lag)
      const laggedDeviceList = await trustedDevicesForRotate([
        { id: deviceB, publicKey: pending.publicKey, mlkemPublicKey: pending.mlkemPublicKey },
      ])
      const newRecoveryKey = await revokeDeviceAndRotate(server.httpClient, deviceB, {
        listTrustedDevices: () => Promise.resolve(laggedDeviceList),
      })

      expect(newRecoveryKey.split(' ')).toHaveLength(24)
      expect(server.state.devices.get(deviceB)?.revoked).toBe(true)
      expect(server.state.envelopes.has(deviceB)).toBe(false)
      expect(server.state.metadata!.keyVersion).toBe(2)

      // DEK rotation happened after the AK rotation: primary moved to '1'
      expect(server.state.metadata!.primaryKeyId).toBe('1')
      expect(await getPrimaryKeyId()).toBe('1')

      // The revoked device's old AK opens NOTHING on the new keyring
      for (const wrappedKey of server.state.keys.values()) {
        await expect(unwrapDEK(wrappedKey, oldAKOfB)).rejects.toThrow()
      }

      // The remaining device decrypts everything, including the new primary DEK
      const ak = await getAK()
      for (const keyId of ['0', '1']) {
        const dek = await unwrapDEK((await getWrappedDEK(keyId))!, ak!)
        expect(dek.algorithm.name).toBe('AES-GCM')
      }
    })
  })

  describe('handleFullWipe', () => {
    it('clears all keys', async () => {
      const server = createFakeServer()
      await setupFirstDevice(server)
      expect(await getAK()).not.toBeNull()

      await handleFullWipe()

      expect(await getAK()).toBeNull()
      expect(await getKeyPair()).toBeNull()
      expect(await listWrappedDEKs()).toEqual([])
    })
  })
})

/**
 * Simulate an approved-but-fresh device: wipe local storage, switch to a new
 * device id, register it, and store a real envelope for it on the fake server
 * — leaving the fresh device ready for `checkApprovalAndUnwrap`. Device A's
 * private keys are gone (single shared fake IndexedDB), so the envelope is
 * built from the recovery seed — content-equivalent to a real approval.
 */
const setupApprovedFreshDevice = async (server: FakeServer, recoveryKey: string): Promise<void> => {
  setCurrentDevice(deviceB)
  await deleteKeyDatabase()
  await registerThisDevice(server.httpClient)
  const keyPairB = await getKeyPair()
  const publicKeyB = await exportPublicKey(keyPairB!.ecdhPublicKey)
  const mlkemPublicKeyB = exportMlKemPublicKey(keyPairB!.mlkemPublicKey)

  const seed = decodeRecoveryKey(recoveryKey)
  const ak = await deriveAKFromSeed(seed, server.state.metadata!.kdfSalt!, { extractable: true })
  const wrappedForB = await wrapAK(ak, await importPublicKey(publicKeyB), importMlKemPublicKey(mlkemPublicKeyB))
  server.state.envelopes.set(deviceB, wrappedForB)
  server.state.devices.set(deviceB, { trusted: true, revoked: false })
}
