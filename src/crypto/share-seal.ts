/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maxShareSnapshotJsonBytes } from '@shared/chat-shares'
import { shareKeyLength, shareKeySealAAD, shareKeySealHkdfInfo, shareKeySealVersion } from '@shared/e2ee-types'
import { DecryptionError, EncryptionError } from './errors'
import type { InboxPublicKeys } from './inbox-key'
import type { StoredKeyPair } from './key-storage'
import {
  aesGcmAlgorithm,
  base64ToUint8Array,
  type HybridSealDomain,
  importMlKemPublicKey,
  importPublicKey,
  ivLength,
  openHybridPayload,
  sealHybridPayload,
  uint8ArrayToBase64,
} from './primitives'

/** Who a share key is sealed for, and in which share. Every field is bound into the seal. */
export type ShareKeySealContext = {
  shareId: string
  ownerUserId: string
  recipientUserId: string
  inboxVersion: number
}

/** A share key: its raw bytes for sealing, and a non-extractable handle for the content. */
export type ShareKey = { raw: Uint8Array; key: CryptoKey }

const importShareKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw as BufferSource, { name: aesGcmAlgorithm, length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])

/** A fresh random share key. One per share; never derived from or stored with account keys. */
export const generateShareKey = async (): Promise<ShareKey> => {
  const raw = crypto.getRandomValues(new Uint8Array(shareKeyLength))
  return { raw, key: await importShareKey(raw) }
}

/** SHA-256 hex over the recipient's inbox ECDH ‖ ML-KEM public keys — binds a seal to the keys it targets. */
const inboxKeyHash = async (publicKeys: InboxPublicKeys): Promise<string> => {
  const ecdh = base64ToUint8Array(publicKeys.ecdhPublicKey)
  const mlkem = base64ToUint8Array(publicKeys.mlkemPublicKey)
  const joined = new Uint8Array(ecdh.length + mlkem.length)
  joined.set(ecdh, 0)
  joined.set(mlkem, ecdh.length)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

const shareKeySealDomain = async (
  context: ShareKeySealContext,
  publicKeys: InboxPublicKeys,
): Promise<HybridSealDomain> => ({
  version: shareKeySealVersion,
  info: new TextEncoder().encode(shareKeySealHkdfInfo),
  aad: shareKeySealAAD(
    context.shareId,
    context.ownerUserId,
    context.recipientUserId,
    context.inboxVersion,
    await inboxKeyHash(publicKeys),
  ),
  minPayloadLength: shareKeyLength,
  label: 'share key seal',
})

/** Seal a share key to one recipient's inbox public keys. */
export const sealShareKey = async (
  shareKey: ShareKey,
  recipient: InboxPublicKeys,
  context: ShareKeySealContext,
): Promise<string> =>
  sealHybridPayload(
    shareKey.raw,
    await importPublicKey(recipient.ecdhPublicKey),
    importMlKemPublicKey(recipient.mlkemPublicKey),
    await shareKeySealDomain(context, recipient),
  )

/**
 * Open a share-key seal. The seal comes from another account by way of the
 * server, so anything that keeps it from opening — a bad tag, a truncated or
 * malformed blob — means "this share cannot be read here", never a crash.
 */
const openSealedRaw = async (sealed: string, inboxKeyPair: StoredKeyPair, domain: HybridSealDomain) => {
  try {
    return await openHybridPayload(sealed, inboxKeyPair.ecdhPrivateKey, inboxKeyPair.mlkemSecretKey, domain)
  } catch (err) {
    throw err instanceof DecryptionError ? err : new DecryptionError('Failed to open share key', { cause: err })
  }
}

/** Open the share key sealed to this account's inbox keypair. */
export const openShareKey = async (
  sealed: string,
  inboxKeyPair: StoredKeyPair,
  inboxPublicKeys: InboxPublicKeys,
  context: ShareKeySealContext,
): Promise<CryptoKey> => {
  const domain = await shareKeySealDomain(context, inboxPublicKeys)
  const raw = await openSealedRaw(sealed, inboxKeyPair, domain)
  try {
    if (raw.length !== shareKeyLength) {
      throw new DecryptionError('Share key has the wrong length')
    }
    return await importShareKey(raw)
  } finally {
    raw.fill(0)
  }
}

/** Encrypt bytes under a share key. Returns base64 `iv ‖ ciphertext`. */
const encryptUnderShareKey = async (data: Uint8Array, key: CryptoKey, aad: Uint8Array): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: aesGcmAlgorithm, iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      data as BufferSource,
    ),
  )
  const blob = new Uint8Array(iv.length + ciphertext.length)
  blob.set(iv, 0)
  blob.set(ciphertext, iv.length)
  return uint8ArrayToBase64(blob)
}

const decryptUnderShareKey = async (blobBase64: string, key: CryptoKey, aad: Uint8Array): Promise<Uint8Array> => {
  try {
    const blob = base64ToUint8Array(blobBase64)
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: aesGcmAlgorithm, iv: blob.slice(0, ivLength) as BufferSource, additionalData: aad as BufferSource },
        key,
        blob.slice(ivLength) as BufferSource,
      ),
    )
  } catch (err) {
    throw new DecryptionError('Failed to decrypt shared content', { cause: err })
  }
}

const gzip = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
  )

/**
 * Gunzip at most `maxBytes` of output. The input is another account's, and
 * gzip of repetitive data inflates about a thousandfold, so the output is read
 * a chunk at a time and the stream abandoned the moment it passes the cap,
 * before it can exhaust memory.
 */
const gunzipAtMost = async (data: Uint8Array, maxBytes: number): Promise<Uint8Array> => {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  const read = async (total: number): Promise<number> => {
    const { done, value } = await reader.read()
    if (done) {
      return total
    }
    if (total + value.length > maxBytes) {
      await reader.cancel()
      throw new DecryptionError('Shared content is too large to open')
    }
    chunks.push(value)
    return read(total + value.length)
  }
  const total = await read(0)
  const out = new Uint8Array(total)
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return out
}

/**
 * Encrypt a JSON value under a share key, gzipped first. Compressing before
 * encrypting tells the server the compressed length, once, which is all a
 * one-off snapshot gives away; there is no repeated attacker-influenced
 * encryption here for a compression oracle to work with.
 */
export const encryptShareJson = async (value: unknown, key: CryptoKey, aad: Uint8Array): Promise<string> => {
  try {
    const compressed = await gzip(new TextEncoder().encode(JSON.stringify(value)))
    return await encryptUnderShareKey(compressed, key, aad)
  } catch (err) {
    throw new EncryptionError('Failed to encrypt shared content', { cause: err })
  }
}

/**
 * Decrypt and parse a value sealed by `encryptShareJson`, refusing one that
 * inflates past `maxShareSnapshotJsonBytes`. The caller validates its shape.
 */
export const decryptShareJson = async (blobBase64: string, key: CryptoKey, aad: Uint8Array): Promise<unknown> => {
  const compressed = await decryptUnderShareKey(blobBase64, key, aad)
  try {
    return JSON.parse(new TextDecoder().decode(await gunzipAtMost(compressed, maxShareSnapshotJsonBytes)))
  } catch (err) {
    // Authenticated but undecodable — bad gzip, bad JSON — is the sender's
    // doing, and reads like any other share this device cannot open.
    throw err instanceof DecryptionError
      ? err
      : new DecryptionError('Shared content could not be decoded', { cause: err })
  }
}

/** Encrypt a short string (a title) under a share key, uncompressed. */
export const encryptShareText = async (text: string, key: CryptoKey, aad: Uint8Array): Promise<string> => {
  try {
    return await encryptUnderShareKey(new TextEncoder().encode(text), key, aad)
  } catch (err) {
    throw new EncryptionError('Failed to encrypt shared content', { cause: err })
  }
}

/** Decrypt a string sealed by `encryptShareText`. */
export const decryptShareText = async (blobBase64: string, key: CryptoKey, aad: Uint8Array): Promise<string> =>
  new TextDecoder().decode(await decryptUnderShareKey(blobBase64, key, aad))

/** Decoded byte length of a base64 string — what the server's size cap measures. */
export const base64ByteLength = (value: string): number => base64ToUint8Array(value).length
