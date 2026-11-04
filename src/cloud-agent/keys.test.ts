/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  decryptScopedJson,
  encryptScopedJson,
  generateResourceIdentity,
  generateResourceKey,
  openResourceKey,
  sealResourceKey,
} from '@shared/cloud-agent/crypto'
import { createOwnerResourceIdentity, openOwnerResourceIdentity, type AccountResourceKeyAccess } from './keys'

/** Emulate a retained account DEK ring without touching browser key storage. */
const keyAccess = (entries: Record<string, CryptoKey>, primary: string | null): AccountResourceKeyAccess => ({
  primaryKeyId: async () => primary,
  resolve: async (keyId) => {
    const key = entries[keyId]
    if (!key) {
      throw new Error('Account key unavailable')
    }
    return key
  },
})

describe('owner resource identity persistence', () => {
  it('stores only an opaque owner-encrypted private identity and opens after a primary-key rotation', async () => {
    const original = await generateResourceKey()
    const stored = await createOwnerResourceIdentity('owner-a', keyAccess({ '0': original }, '0'))
    const opened = await openOwnerResourceIdentity(
      stored,
      'owner-a',
      keyAccess({ '0': original, '1': await generateResourceKey() }, '1'),
    )
    expect(opened.publicKey).toEqual(stored.publicKey)
    expect(JSON.stringify(stored)).not.toContain(opened.ecdhPrivateKey)
    expect(JSON.stringify(stored)).not.toContain(opened.mlkemSecretKey)
    expect(JSON.stringify(stored)).not.toContain('__enc:')
  })

  it('allows autonomous cloud artifact creation while the account DEK stays exclusively on the client', async () => {
    const access = keyAccess({ '0': await generateResourceKey() }, '0')
    const stored = await createOwnerResourceIdentity('owner-a', access)
    const artifactKey = await generateResourceKey()
    const context = { ownerId: 'owner-a', scopeId: 'artifact:a', keyEpoch: 1, recipientId: 'owner-a' }
    // The cloud needs only the owner's public recipient to produce the recovery envelope.
    const envelope = await sealResourceKey(artifactKey, stored.publicKey, context)
    const payloadContext = { ...context, recordId: 'revision-a', purpose: 'artifact' }
    const artifact = await encryptScopedJson({ content: 'made while offline' }, artifactKey, payloadContext)
    const owner = await openOwnerResourceIdentity(stored, 'owner-a', access)
    const recoveredKey = await openResourceKey(envelope, owner, context)
    expect(await decryptScopedJson(artifact, recoveredKey, payloadContext)).toEqual({ content: 'made while offline' })
  })

  it('rejects a relabelled owner, private ciphertext, or substituted public recipient', async () => {
    const access = keyAccess({ '0': await generateResourceKey() }, '0')
    const stored = await createOwnerResourceIdentity('owner-a', access)
    const other = await generateResourceIdentity()
    await expect(openOwnerResourceIdentity(stored, 'owner-b', access)).rejects.toThrow()
    await expect(
      openOwnerResourceIdentity(
        { ...stored, publicKey: { ...other.publicKey, keyId: stored.publicKey.keyId } },
        'owner-a',
        access,
      ),
    ).rejects.toThrow()
    await expect(
      openOwnerResourceIdentity(
        { ...stored, accountKeyId: '1' },
        'owner-a',
        keyAccess({ '1': await generateResourceKey() }, '1'),
      ),
    ).rejects.toThrow()
  })

  it('fails closed when account encryption is missing or its historical key is unavailable', async () => {
    await expect(createOwnerResourceIdentity('owner-a', keyAccess({}, null))).rejects.toThrow()
    await expect(createOwnerResourceIdentity('owner-a', keyAccess({}, '0'))).rejects.toThrow()
    const stored = await createOwnerResourceIdentity('owner-a', keyAccess({ '0': await generateResourceKey() }, '0'))
    await expect(openOwnerResourceIdentity(stored, 'owner-a', keyAccess({}, '1'))).rejects.toThrow()
  })
})
