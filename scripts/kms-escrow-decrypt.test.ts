/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { generateAK, wrapAKForOrg } from '../src/crypto/primitives'
import { encodeAAD, encV2Prefix, encPrefix, legacyKeyId, initialKeyId } from '../shared/e2ee-types'
import {
  assertSafeIdentifier,
  deriveOrgUnwrapKey,
  deriveSharedSecret,
  decryptValue,
  parseEncryptedValue,
  parseOrgEnvelope,
  unwrapAk,
  unwrapDek,
} from './kms-escrow-decrypt'

/** Generate an extractable ECDH-P256 keypair standing in for the org's escrow keypair. */
const generateOrgKeypair = () =>
  crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as Promise<CryptoKeyPair>

const exportPkcs8Base64 = async (key: CryptoKey): Promise<string> =>
  Buffer.from(await crypto.subtle.exportKey('pkcs8', key)).toString('base64')

/** Recover the AK from an org envelope exactly as the CLI tool's `main()` does, minus the DB I/O. */
const recoverAk = async (envelopeBase64: string, orgPrivateKeyBase64: string) => {
  const { ephPubRaw, wrappedAkBytes } = parseOrgEnvelope(envelopeBase64)
  const sharedSecret = await deriveSharedSecret(orgPrivateKeyBase64, ephPubRaw)
  const unwrapKey = await deriveOrgUnwrapKey(sharedSecret, ephPubRaw)
  return unwrapAk(wrappedAkBytes, unwrapKey)
}

describe('kms-escrow-decrypt', () => {
  describe('assertSafeIdentifier', () => {
    it('accepts snake_case identifiers', () => {
      expect(() => assertSafeIdentifier('chat_messages', 'table')).not.toThrow()
      expect(() => assertSafeIdentifier('content', 'column')).not.toThrow()
    })

    it('rejects identifiers that are not plain snake_case', () => {
      expect(() => assertSafeIdentifier('chat_messages; DROP TABLE users;--', 'table')).toThrow()
      expect(() => assertSafeIdentifier('"quoted"', 'table')).toThrow()
      expect(() => assertSafeIdentifier('Chat_Messages', 'table')).toThrow()
      expect(() => assertSafeIdentifier('1table', 'table')).toThrow()
      expect(() => assertSafeIdentifier('', 'column')).toThrow()
    })
  })

  describe('org envelope -> AK recovery (static mode)', () => {
    it('recovers the exact AK wrapAKForOrg wrapped, given only the org private key', async () => {
      const orgKeypair = await generateOrgKeypair()
      const orgPrivateKeyBase64 = await exportPkcs8Base64(orgKeypair.privateKey)
      const ak = await generateAK(true)

      const envelope = await wrapAKForOrg(ak, orgKeypair.publicKey)
      const recoveredAk = await recoverAk(envelope, orgPrivateKeyBase64)

      // The recovered AK only carries 'unwrapKey' (mirrors the real tool — it never
      // needs to wrap anything). Prove it's the SAME key functionally: wrap a DEK
      // under the original AK, then unwrap it under the recovered one and use it
      // to decrypt something real.
      const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      const wrappedDek = Buffer.from(await crypto.subtle.wrapKey('raw', dek, ak, 'AES-KW')).toString('base64')
      const recoveredDek = await unwrapDek(wrappedDek, recoveredAk)

      const iv = crypto.getRandomValues(new Uint8Array(12))
      const aad = encodeAAD('chat_messages', 'content', 'row-1', initialKeyId)
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        dek,
        new TextEncoder().encode('hello from escrow'),
      )
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        recoveredDek,
        ciphertext,
      )
      expect(new TextDecoder().decode(plaintext)).toBe('hello from escrow')
    })

    it('fails to recover the AK with the wrong org private key', async () => {
      const orgKeypair = await generateOrgKeypair()
      const wrongKeypair = await generateOrgKeypair()
      const wrongPrivateKeyBase64 = await exportPkcs8Base64(wrongKeypair.privateKey)
      const ak = await generateAK(true)

      const envelope = await wrapAKForOrg(ak, orgKeypair.publicKey)
      await expect(recoverAk(envelope, wrongPrivateKeyBase64)).rejects.toThrow()
    })

    it('rejects an envelope with an unsupported version byte', () => {
      const envelope = new Uint8Array(1 + 65 + 40)
      envelope[0] = 0x02 // only 0x01 is defined
      expect(() => parseOrgEnvelope(Buffer.from(envelope).toString('base64'))).toThrow(/version/i)
    })
  })

  describe('parseEncryptedValue', () => {
    it('parses a v2 value and rebuilds its AAD context', () => {
      const parsed = parseEncryptedValue(`${encV2Prefix}0:aXY=:Y3Q=`, {
        table: 'chat_messages',
        column: 'content',
        rowId: 'row-1',
      })
      expect(parsed.keyId).toBe('0')
      expect(parsed.aad).toEqual(encodeAAD('chat_messages', 'content', 'row-1', '0'))
    })

    it('parses a legacy v1 value with no AAD', () => {
      const parsed = parseEncryptedValue(`${encPrefix}aXY=:Y3Q=`, {
        table: 'chat_messages',
        column: 'content',
        rowId: 'row-1',
      })
      expect(parsed.keyId).toBe(legacyKeyId)
      expect(parsed.aad).toBeUndefined()
    })

    it('rejects a value with no recognized encryption prefix', () => {
      expect(() =>
        parseEncryptedValue('plaintext', { table: 'chat_messages', column: 'content', rowId: 'row-1' }),
      ).toThrow()
    })

    it('rejects a malformed v2 value (missing segments)', () => {
      expect(() =>
        parseEncryptedValue(`${encV2Prefix}0:onlyoneseg`, {
          table: 'chat_messages',
          column: 'content',
          rowId: 'row-1',
        }),
      ).toThrow(/malformed/i)
    })
  })

  describe('decryptValue', () => {
    it('round-trips a v2 value end to end (envelope -> AK -> DEK -> plaintext)', async () => {
      const orgKeypair = await generateOrgKeypair()
      const orgPrivateKeyBase64 = await exportPkcs8Base64(orgKeypair.privateKey)
      const ak = await generateAK(true)
      const envelope = await wrapAKForOrg(ak, orgKeypair.publicKey)
      const recoveredAk = await recoverAk(envelope, orgPrivateKeyBase64)

      const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      const wrappedDek = Buffer.from(await crypto.subtle.wrapKey('raw', dek, ak, 'AES-KW')).toString('base64')
      const recoveredDek = await unwrapDek(wrappedDek, recoveredAk)

      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ctx = { table: 'chat_messages', column: 'content', rowId: 'row-42' }
      const aad = encodeAAD(ctx.table, ctx.column, ctx.rowId, initialKeyId)
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad },
          dek,
          new TextEncoder().encode('secret plaintext'),
        ),
      )
      const wireValue = `${encV2Prefix}${initialKeyId}:${Buffer.from(iv).toString('base64')}:${Buffer.from(ciphertext).toString('base64')}`

      const parsed = parseEncryptedValue(wireValue, ctx)
      const plaintext = await decryptValue(parsed, recoveredDek)
      expect(plaintext).toBe('secret plaintext')
    })

    it('round-trips a legacy v1 value (no AAD)', async () => {
      const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, new TextEncoder().encode('legacy plaintext')),
      )
      const wireValue = `${encPrefix}${Buffer.from(iv).toString('base64')}:${Buffer.from(ciphertext).toString('base64')}`

      const parsed = parseEncryptedValue(wireValue, { table: 'chat_messages', column: 'content', rowId: 'row-1' })
      const plaintext = await decryptValue(parsed, dek)
      expect(plaintext).toBe('legacy plaintext')
    })
  })
})
