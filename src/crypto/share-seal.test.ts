/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { shareSnapshotAAD, shareTitleAAD } from '@shared/e2ee-types'

import { deriveInboxKeyPair, exportInboxPublicKeys, generateInboxSeed } from './inbox-key'
import { maxShareSnapshotBytes, maxShareSnapshotJsonBytes } from '@shared/chat-shares'
import { DecryptionError } from './errors'
import {
  base64ByteLength,
  decryptShareJson,
  decryptShareText,
  encryptShareJson,
  encryptShareText,
  generateShareKey,
  openShareKey,
  sealShareKey,
  type ShareKeySealContext,
} from './share-seal'

const context: ShareKeySealContext = {
  shareId: 'share-1',
  ownerUserId: 'alice',
  recipientUserId: 'bob',
  inboxVersion: 1,
}

/** Bob's inbox keypair and the public keys the directory would serve for it. */
const bobInbox = async () => {
  const keyPair = await deriveInboxKeyPair(generateInboxSeed())
  return { keyPair, publicKeys: await exportInboxPublicKeys(keyPair) }
}

describe('sealShareKey / openShareKey', () => {
  it('opens a share key sealed to the recipient’s inbox key', async () => {
    const bob = await bobInbox()
    const shareKey = await generateShareKey()
    const sealed = await sealShareKey(shareKey, bob.publicKeys, context)

    const opened = await openShareKey(sealed, bob.keyPair, bob.publicKeys, context)

    const aad = shareTitleAAD('share-1', 'alice')
    expect(await decryptShareText(await encryptShareText('hello', shareKey.key, aad), opened, aad)).toBe('hello')
  })

  it.each([
    ['another share', { shareId: 'share-2' }],
    ['another owner', { ownerUserId: 'mallory' }],
    ['another recipient', { recipientUserId: 'carol' }],
    ['another inbox version', { inboxVersion: 2 }],
  ])('refuses a seal moved to %s', async (_, moved) => {
    const bob = await bobInbox()
    const sealed = await sealShareKey(await generateShareKey(), bob.publicKeys, context)
    await expect(openShareKey(sealed, bob.keyPair, bob.publicKeys, { ...context, ...moved })).rejects.toBeInstanceOf(
      DecryptionError,
    )
  })

  it('refuses to open with an inbox key it was not sealed to', async () => {
    const bob = await bobInbox()
    const carol = await bobInbox()
    const sealed = await sealShareKey(await generateShareKey(), bob.publicKeys, context)
    await expect(openShareKey(sealed, carol.keyPair, carol.publicKeys, context)).rejects.toBeInstanceOf(DecryptionError)
  })

  it('binds the seal to the published public keys it targets', async () => {
    const bob = await bobInbox()
    const other = await bobInbox()
    const sealed = await sealShareKey(await generateShareKey(), bob.publicKeys, context)
    await expect(openShareKey(sealed, bob.keyPair, other.publicKeys, context)).rejects.toBeInstanceOf(DecryptionError)
  })
})

describe('encryptShareJson / decryptShareJson', () => {
  it('round-trips a value through gzip and AES-GCM', async () => {
    const { key } = await generateShareKey()
    const aad = shareSnapshotAAD('share-1', 'alice')
    const value = {
      messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: 'repeated text '.repeat(20) })),
    }

    const sealed = await encryptShareJson(value, key, aad)

    expect(await decryptShareJson(sealed, key, aad)).toEqual(value)
    // Repetitive chat text compresses well below its JSON size.
    expect(sealed.length).toBeLessThan(JSON.stringify(value).length / 4)
  })

  it('refuses a snapshot moved to another share', async () => {
    const { key } = await generateShareKey()
    const sealed = await encryptShareJson({ a: 1 }, key, shareSnapshotAAD('share-1', 'alice'))
    await expect(decryptShareJson(sealed, key, shareSnapshotAAD('share-2', 'alice'))).rejects.toThrow(
      'Failed to decrypt shared content',
    )
  })

  it('refuses a snapshot that inflates past the size a recipient will open', async () => {
    const { key } = await generateShareKey()
    const aad = shareSnapshotAAD('share-1', 'alice')
    // Compresses to a few KB, inflates past the cap.
    const bomb = await encryptShareJson('a'.repeat(maxShareSnapshotJsonBytes + 1), key, aad)

    expect(base64ByteLength(bomb)).toBeLessThan(maxShareSnapshotBytes)
    await expect(decryptShareJson(bomb, key, aad)).rejects.toThrow('Shared content is too large to open')
  })

  it('reads authenticated content that is not gzip as unopenable, not as a crash', async () => {
    const { key } = await generateShareKey()
    const aad = shareSnapshotAAD('share-1', 'alice')
    const notGzip = await encryptShareText('{"plain": "json"}', key, aad)

    await expect(decryptShareJson(notGzip, key, aad)).rejects.toBeInstanceOf(DecryptionError)
  })

  it('keeps the snapshot and title domains apart', async () => {
    const { key } = await generateShareKey()
    const sealed = await encryptShareText('title', key, shareTitleAAD('share-1', 'alice'))
    await expect(decryptShareText(sealed, key, shareSnapshotAAD('share-1', 'alice'))).rejects.toBeInstanceOf(
      DecryptionError,
    )
  })
})
