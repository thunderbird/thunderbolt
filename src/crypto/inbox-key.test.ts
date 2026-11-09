/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { inboxSeedAAD } from '@shared/e2ee-types'

import {
  decryptInboxSeed,
  deriveInboxKeyPair,
  encryptInboxSeed,
  exportInboxPublicKeys,
  generateInboxSeed,
  openInboxKeyPair,
} from './inbox-key'
import { derivePasskeyKeyPair } from './passkey-key'
import { exportMlKemPublicKey, exportPublicKey, generateDEK } from './primitives'

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

const aad = inboxSeedAAD('user-1', 1, '0')

/** A published inbox row for a fresh seed, plus the DEK its seed is sealed under. */
const publishedRow = async () => {
  const seed = generateInboxSeed()
  const dek = await generateDEK()
  const publicKeys = await exportInboxPublicKeys(await deriveInboxKeyPair(seed))
  return { dek, seed, row: { ...publicKeys, encryptedSeed: await encryptInboxSeed(seed, dek, aad) } }
}

describe('deriveInboxKeyPair', () => {
  it('derives byte-identical public keys from the same seed', async () => {
    const seed = generateInboxSeed()
    expect(await exportInboxPublicKeys(await deriveInboxKeyPair(seed))).toEqual(
      await exportInboxPublicKeys(await deriveInboxKeyPair(seed)),
    )
  })

  // The HKDF labels are a wire contract: a change would strand every share.
  it('matches the frozen known-answer vector', async () => {
    const keyPair = await deriveInboxKeyPair(new Uint8Array(32).map((_, i) => i))
    expect(await exportPublicKey(keyPair.ecdhPublicKey)).toBe(
      'BK9h9qaE7jNuVV8yUDJU8yot5IfR4iHCvbGGc2H5AmIYkMYvNvLmkewHHFE/R3z2EpK2G8+dboIclxRIdtxoG5E=',
    )
    expect(await sha256Hex(keyPair.mlkemPublicKey)).toBe(
      '053269645340c6d8f54c1dffdfa763fed55f502cccc780eb0d23527fa13f1471',
    )
  })

  it('is domain-separated from the passkey slot', async () => {
    const seed = new Uint8Array(32).map((_, i) => i)
    const inbox = await deriveInboxKeyPair(seed)
    const passkey = await derivePasskeyKeyPair(seed)
    expect(await exportPublicKey(inbox.ecdhPublicKey)).not.toBe(await exportPublicKey(passkey.ecdhPublicKey))
    expect(exportMlKemPublicKey(inbox.mlkemPublicKey)).not.toBe(exportMlKemPublicKey(passkey.mlkemPublicKey))
  })
})

describe('encryptInboxSeed / decryptInboxSeed', () => {
  it('round-trips a seed', async () => {
    const seed = generateInboxSeed()
    const dek = await generateDEK()
    expect(await decryptInboxSeed(await encryptInboxSeed(seed, dek, aad), dek, aad)).toEqual(seed)
  })

  it.each([
    ['another account', inboxSeedAAD('user-2', 1, '0')],
    ['another version', inboxSeedAAD('user-1', 2, '0')],
    ['another key_id', inboxSeedAAD('user-1', 1, '1')],
  ])('refuses a seed relabelled as %s', async (_, otherAad) => {
    const dek = await generateDEK()
    const sealed = await encryptInboxSeed(generateInboxSeed(), dek, aad)
    await expect(decryptInboxSeed(sealed, dek, otherAad)).rejects.toThrow('Failed to decrypt inbox seed')
  })

  it('refuses the wrong DEK', async () => {
    const sealed = await encryptInboxSeed(generateInboxSeed(), await generateDEK(), aad)
    await expect(decryptInboxSeed(sealed, await generateDEK(), aad)).rejects.toThrow('Failed to decrypt inbox seed')
  })
})

describe('openInboxKeyPair', () => {
  it('opens a row whose public keys match its seed', async () => {
    const { dek, seed, row } = await publishedRow()
    const keyPair = await openInboxKeyPair(row, dek, aad)
    expect(await exportInboxPublicKeys(keyPair)).toEqual(await exportInboxPublicKeys(await deriveInboxKeyPair(seed)))
  })

  it('refuses a row whose published public keys belong to another seed', async () => {
    const { dek, row } = await publishedRow()
    const planted = await exportInboxPublicKeys(await deriveInboxKeyPair(generateInboxSeed()))
    await expect(openInboxKeyPair({ ...row, ecdhPublicKey: planted.ecdhPublicKey }, dek, aad)).rejects.toThrow(
      'Inbox key does not match its published public keys',
    )
    await expect(openInboxKeyPair({ ...row, mlkemPublicKey: planted.mlkemPublicKey }, dek, aad)).rejects.toThrow(
      'Inbox key does not match its published public keys',
    )
  })
})
