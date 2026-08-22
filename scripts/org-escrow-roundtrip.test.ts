/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * DB-free round trip of the THU-804 escrow tooling: keygen → a simulated
 * FRONTEND wrap (written inline per the frozen contract in
 * docs/architecture/e2ee-org-escrow-poc-plan.md, independent of the decrypt
 * script) → the decrypt script's exported functions. Proves the operator
 * tooling inverts exactly what Track B's `wrapAKForOrg` produces.
 */

import { describe, expect, test } from 'bun:test'
import { encPrefix, encV2Prefix, encodeAAD, legacyKeyId, orgEnvelopeVersion, orgEscrowHkdfInfo } from '../shared/e2ee-types'
import { decryptCellValue, parseOrgEnvelope, unwrapEscrowedAK, unwrapKeyring } from './org-escrow-decrypt'
import { generateEscrowKeypair } from './org-escrow-keygen'

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** Simulated frontend `wrapAKForOrg` — the frozen envelope format, written from the contract. */
const wrapAkForOrg = async (ak: CryptoKey, operatorPublicKeyBase64: string): Promise<string> => {
  const operatorPublicKey = await crypto.subtle.importKey(
    'raw',
    Buffer.from(operatorPublicKeyBase64, 'base64') as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: operatorPublicKey }, ephemeral.privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  const kwKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ephPubRaw as BufferSource, info: new TextEncoder().encode(orgEscrowHkdfInfo) },
    hkdfKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey'],
  )
  const wrappedAk = new Uint8Array(await crypto.subtle.wrapKey('raw', ak, kwKey, 'AES-KW'))

  const envelope = new Uint8Array(1 + ephPubRaw.length + wrappedAk.length)
  envelope[0] = orgEnvelopeVersion
  envelope.set(ephPubRaw, 1)
  envelope.set(wrappedAk, 1 + ephPubRaw.length)
  return toBase64(envelope)
}

const generateAk = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey']) as Promise<CryptoKey>

const mintWrappedDek = async (ak: CryptoKey): Promise<{ dek: CryptoKey; wrappedKey: string }> => {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const wrappedKey = toBase64(new Uint8Array(await crypto.subtle.wrapKey('raw', dek, ak, 'AES-KW')))
  return { dek, wrappedKey }
}

const encryptV2 = async (plaintext: string, dek: CryptoKey, aad: Uint8Array, keyId: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad as BufferSource },
      dek,
      new TextEncoder().encode(plaintext),
    ),
  )
  return `${encV2Prefix}${keyId}:${toBase64(iv)}:${toBase64(ct)}`
}

const encryptV1 = async (plaintext: string, dek: CryptoKey): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, new TextEncoder().encode(plaintext)))
  return `${encPrefix}${toBase64(iv)}:${toBase64(ct)}`
}

describe('org escrow round trip (keygen → frontend wrap → decrypt tool)', () => {
  test('recovers a v2 value through the full escrow pipeline', async () => {
    const keypair = await generateEscrowKeypair()
    expect(Buffer.from(keypair.publicKey, 'base64')).toHaveLength(65)
    expect(Buffer.from(keypair.publicKey, 'base64')[0]).toBe(0x04)

    const ak = await generateAk()
    const envelope = await wrapAkForOrg(ak, keypair.publicKey)
    const primary = await mintWrappedDek(ak)

    const ctx = { table: 'tasks', column: 'item', rowId: 'row-123' }
    const wire = await encryptV2('the secret task', primary.dek, encodeAAD(ctx.table, ctx.column, ctx.rowId, '0'), '0')

    const recoveredAk = await unwrapEscrowedAK(parseOrgEnvelope(envelope), keypair.privateKey)
    const deks = await unwrapKeyring([{ keyId: '0', wrappedKey: primary.wrappedKey }], recoveredAk)
    const result = await decryptCellValue(wire, deks, ctx)

    expect(result).toEqual({ plaintext: 'the secret task', wasEncrypted: true })
  })

  test('recovers a legacy v1 value with the "v1" DEK and no AAD', async () => {
    const keypair = await generateEscrowKeypair()
    const ak = await generateAk()
    const envelope = await wrapAkForOrg(ak, keypair.publicKey)
    const legacy = await mintWrappedDek(ak)

    const wire = await encryptV1('legacy plaintext', legacy.dek)

    const recoveredAk = await unwrapEscrowedAK(parseOrgEnvelope(envelope), keypair.privateKey)
    const deks = await unwrapKeyring([{ keyId: legacyKeyId, wrappedKey: legacy.wrappedKey }], recoveredAk)
    const result = await decryptCellValue(wire, deks, { table: 'tasks', column: 'item', rowId: 'row-123' })

    expect(result).toEqual({ plaintext: 'legacy plaintext', wasEncrypted: true })
  })

  test('passes unencrypted values through unchanged', async () => {
    const result = await decryptCellValue('just plaintext', new Map(), { table: 'tasks', column: 'item', rowId: 'x' })
    expect(result).toEqual({ plaintext: 'just plaintext', wasEncrypted: false })
  })

  test('rejects a mismatched operator private key with a descriptive error', async () => {
    const rightKeypair = await generateEscrowKeypair()
    const wrongKeypair = await generateEscrowKeypair()
    const ak = await generateAk()
    const envelope = await wrapAkForOrg(ak, rightKeypair.publicKey)

    expect(unwrapEscrowedAK(parseOrgEnvelope(envelope), wrongKeypair.privateKey)).rejects.toThrow(
      /private key does not match the escrow envelope/,
    )
  })

  test('rejects a wrong envelope version byte', async () => {
    const keypair = await generateEscrowKeypair()
    const ak = await generateAk()
    const envelope = Buffer.from(await wrapAkForOrg(ak, keypair.publicKey), 'base64')
    envelope[0] = 0x02

    expect(() => parseOrgEnvelope(envelope.toString('base64'))).toThrow(/Unsupported org envelope version: 0x02/)
  })

  test('fails v2 decryption on an AAD mismatch (wrong row id)', async () => {
    const keypair = await generateEscrowKeypair()
    const ak = await generateAk()
    const envelope = await wrapAkForOrg(ak, keypair.publicKey)
    const primary = await mintWrappedDek(ak)

    const wire = await encryptV2('bound value', primary.dek, encodeAAD('tasks', 'item', 'row-123', '0'), '0')

    const recoveredAk = await unwrapEscrowedAK(parseOrgEnvelope(envelope), keypair.privateKey)
    const deks = await unwrapKeyring([{ keyId: '0', wrappedKey: primary.wrappedKey }], recoveredAk)

    expect(decryptCellValue(wire, deks, { table: 'tasks', column: 'item', rowId: 'other-row' })).rejects.toThrow(
      /AAD mismatch/,
    )
  })
})
