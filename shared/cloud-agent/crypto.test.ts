/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  decryptScopedBytes,
  decryptScopedJson,
  encryptScopedBytes,
  encryptScopedJson,
  generateResourceIdentity,
  generateResourceKey,
  indexScopedValue,
  openResourceKey,
  parseResourceIdentity,
  resourceIdentityFingerprint,
  sealResourceKey,
  type ResourceKeyContext,
  type ScopedPayloadContext,
} from './crypto'

const grant: ResourceKeyContext = { ownerId: 'owner-a', scopeId: 'agent:a', keyEpoch: 1, recipientId: 'runtime-a' }
const record: ScopedPayloadContext = {
  ownerId: 'owner-a',
  scopeId: 'agent:a',
  keyEpoch: 1,
  recordId: 'message-a',
  purpose: 'message',
}

/** Modify one decoded byte while preserving a canonical base64 representation. */
const tamper = (value: string): string => {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
  return btoa(String.fromCharCode(...bytes))
}

describe('resource key envelopes', () => {
  it('round-trips a serialized runtime grant and keeps opened keys non-extractable', async () => {
    const identity = await generateResourceIdentity()
    const key = await generateResourceKey()
    const envelope = await sealResourceKey(key, identity.publicKey, grant)
    const parsedIdentity = parseResourceIdentity(JSON.parse(JSON.stringify(identity)))
    const opened = await openResourceKey(JSON.parse(JSON.stringify(envelope)), parsedIdentity, grant)
    expect(opened.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', opened)).rejects.toThrow()
    const payload = await encryptScopedJson({ text: 'private α / 日本語' }, key, record)
    expect(await decryptScopedJson(payload, opened, record)).toEqual({ text: 'private α / 日本語' })
    expect(JSON.stringify(envelope)).not.toContain('__enc:')
    expect(JSON.stringify(envelope)).not.toContain(identity.ecdhPrivateKey)
    expect(JSON.stringify(envelope)).not.toContain(identity.mlkemSecretKey)
  })

  it('supports explicit regranting without sharing any account key', async () => {
    const owner = await generateResourceIdentity()
    const runtime = await generateResourceIdentity()
    const key = await generateResourceKey()
    const ownerContext = { ...grant, recipientId: grant.ownerId }
    const ownerEnvelope = await sealResourceKey(key, owner.publicKey, ownerContext)
    const owned = await openResourceKey(ownerEnvelope, owner, ownerContext, true)
    const runtimeEnvelope = await sealResourceKey(owned, runtime.publicKey, grant)
    const runtimeKey = await openResourceKey(runtimeEnvelope, runtime, grant)
    const payload = await encryptScopedJson(['approved'], key, record)
    expect(await decryptScopedJson(payload, runtimeKey, record)).toEqual(['approved'])
  })

  it.each([
    ['ownerId', 'owner-b'],
    ['scopeId', 'agent:b'],
    ['keyEpoch', 2],
    ['recipientId', 'runtime-b'],
  ] as const)('rejects a grant moved to another %s', async (field, value) => {
    const identity = await generateResourceIdentity()
    const envelope = await sealResourceKey(await generateResourceKey(), identity.publicKey, grant)
    await expect(openResourceKey(envelope, identity, { ...grant, [field]: value })).rejects.toThrow()
  })

  it.each(['ephemeralPublicKey', 'mlkemCiphertext', 'iv', 'ciphertext'] as const)(
    'rejects tampered %s',
    async (field) => {
      const identity = await generateResourceIdentity()
      const envelope = await sealResourceKey(await generateResourceKey(), identity.publicKey, grant)
      await expect(
        openResourceKey({ ...envelope, [field]: tamper(envelope[field]) }, identity, grant),
      ).rejects.toThrow()
    },
  )

  it('rejects different private keys, even when a recipient label is copied', async () => {
    const owner = await generateResourceIdentity()
    const other = await generateResourceIdentity()
    const envelope = await sealResourceKey(await generateResourceKey(), owner.publicKey, grant)
    await expect(openResourceKey(envelope, { ...other, publicKey: owner.publicKey }, grant)).rejects.toThrow()
  })

  it('authenticates the public identity and its key version', async () => {
    const identity = await generateResourceIdentity()
    const other = await generateResourceIdentity()
    const envelope = await sealResourceKey(await generateResourceKey(), identity.publicKey, grant)
    await expect(openResourceKey({ ...envelope, recipientKeyId: 'new' }, identity, grant)).rejects.toThrow()
    await expect(
      openResourceKey(
        envelope,
        { ...identity, publicKey: { ...identity.publicKey, mlkemPublicKey: other.publicKey.mlkemPublicKey } },
        grant,
      ),
    ).rejects.toThrow()
  })

  it('uses fresh encapsulation and IVs for repeated envelopes', async () => {
    const identity = await generateResourceIdentity()
    const key = await generateResourceKey()
    const first = await sealResourceKey(key, identity.publicKey, grant)
    const second = await sealResourceKey(key, identity.publicKey, grant)
    expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey)
    expect(first.mlkemCiphertext).not.toBe(second.mlkemCiphertext)
    expect(first.iv).not.toBe(second.iv)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid epoch %s before creating a grant',
    async (keyEpoch) => {
      const identity = await generateResourceIdentity()
      await expect(
        sealResourceKey(await generateResourceKey(), identity.publicKey, { ...grant, keyEpoch }),
      ).rejects.toThrow()
    },
  )

  it('rejects empty scope identifiers and invalid public key encodings', async () => {
    const identity = await generateResourceIdentity()
    const key = await generateResourceKey()
    await expect(sealResourceKey(key, identity.publicKey, { ...grant, ownerId: '' })).rejects.toThrow()
    await expect(sealResourceKey(key, identity.publicKey, { ...grant, recipientId: '' })).rejects.toThrow()
    await expect(sealResourceKey(key, { ...identity.publicKey, mlkemPublicKey: 'AAAA' }, grant)).rejects.toThrow()
    await expect(
      sealResourceKey(key, { ...identity.publicKey, ecdhPublicKey: `${identity.publicKey.ecdhPublicKey}\n` }, grant),
    ).rejects.toThrow()
  })

  it('rejects unsupported formats without treating them as account envelopes', async () => {
    const identity = await generateResourceIdentity()
    const envelope = await sealResourceKey(await generateResourceKey(), identity.publicKey, grant)
    await expect(
      openResourceKey({ ...envelope, version: 2 } as unknown as typeof envelope, identity, grant),
    ).rejects.toThrow()
    await expect(
      openResourceKey({ ...envelope, kind: 'account-key' } as unknown as typeof envelope, identity, grant),
    ).rejects.toThrow()
  })

  it('fingerprints canonical public identities, including identity version', async () => {
    const identity = await generateResourceIdentity()
    const fingerprint = await resourceIdentityFingerprint(identity.publicKey)
    expect(await resourceIdentityFingerprint({ ...identity.publicKey })).toBe(fingerprint)
    expect(await resourceIdentityFingerprint({ ...identity.publicKey, keyId: 'replacement' })).not.toBe(fingerprint)
  })

  it.each([null, {}, { publicKey: null }, { publicKey: { version: 2 } }])(
    'rejects malformed serialized private identities',
    (value) => {
      expect(() => parseResourceIdentity(value)).toThrow()
    },
  )
})

describe('scoped content encryption', () => {
  it.each([
    ['ownerId', 'owner-b'],
    ['scopeId', 'artifact:b'],
    ['keyEpoch', 2],
    ['recordId', 'message-b'],
    ['purpose', 'approval'],
  ] as const)('rejects content moved to another %s', async (field, value) => {
    const key = await generateResourceKey()
    const payload = await encryptScopedJson({ token: 'private' }, key, record)
    await expect(decryptScopedJson(payload, key, { ...record, [field]: value })).rejects.toThrow()
  })

  it('does not alias scope tuples containing delimiters', async () => {
    const key = await generateResourceKey()
    const payload = await encryptScopedJson('private', key, { ...record, ownerId: 'a\u001fb', scopeId: 'c' })
    await expect(decryptScopedJson(payload, key, { ...record, ownerId: 'a', scopeId: 'b\u001fc' })).rejects.toThrow()
  })

  it('rejects tampered bytes, IVs, wrong keys, and format downgrades', async () => {
    const key = await generateResourceKey()
    const payload = await encryptScopedJson('private', key, record)
    await expect(
      decryptScopedJson({ ...payload, ciphertext: tamper(payload.ciphertext) }, key, record),
    ).rejects.toThrow()
    await expect(decryptScopedJson({ ...payload, iv: tamper(payload.iv) }, key, record)).rejects.toThrow()
    await expect(decryptScopedJson(payload, await generateResourceKey(), record)).rejects.toThrow()
    await expect(
      decryptScopedJson({ ...payload, version: 0 } as unknown as typeof payload, key, record),
    ).rejects.toThrow()
  })

  it('round-trips empty and binary artifact data larger than a base64 chunk', async () => {
    const key = await generateResourceKey()
    const empty = await encryptScopedBytes(new Uint8Array(), key, record)
    expect(await decryptScopedBytes(empty, key, record)).toEqual(new Uint8Array())
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256)
    const encrypted = await encryptScopedBytes(bytes, key, record)
    expect(await decryptScopedBytes(encrypted, key, record)).toEqual(bytes)
  })

  it('rejects invalid JSON inputs and binary payloads masquerading as JSON', async () => {
    const key = await generateResourceKey()
    await expect(encryptScopedJson(undefined, key, record)).rejects.toThrow()
    const binary = await encryptScopedBytes(new Uint8Array([255]), key, record)
    await expect(decryptScopedJson(binary, key, record)).rejects.toThrow()
  })

  it('keeps private index tokens stable and domain-separated', async () => {
    const key = await generateResourceKey()
    const token = await indexScopedValue('find-this', key, record)
    expect(await indexScopedValue('find-this', key, record)).toBe(token)
    for (const context of [
      { ...record, ownerId: 'other' },
      { ...record, scopeId: 'other' },
      { ...record, keyEpoch: 2 },
      { ...record, purpose: 'other' },
    ]) {
      expect(await indexScopedValue('find-this', key, context)).not.toBe(token)
    }
    expect(await indexScopedValue('another-value', key, record)).not.toBe(token)
    expect(await indexScopedValue('find-this', await generateResourceKey(), record)).not.toBe(token)
  })
})
