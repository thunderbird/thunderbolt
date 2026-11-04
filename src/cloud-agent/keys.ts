/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAK, getDEK, getPrimaryKeyId } from '@/crypto/key-storage'
import { unwrapDEK } from '@/crypto/primitives'
import {
  decryptScopedJson,
  encryptScopedJson,
  generateResourceIdentity,
  parseResourceIdentity,
  resourceIdentityFingerprint,
  type ResourceIdentity,
  type ResourcePublicKey,
  type ScopedCiphertext,
  type ScopedPayloadContext,
} from '@shared/cloud-agent/crypto'

/** Persist this opaque record through the cloud identity API, never its decrypted private identity. */
export type OwnerResourceIdentityRecord = {
  version: 1
  accountKeyId: string
  publicKey: ResourcePublicKey
  ciphertext: ScopedCiphertext
}

export type AccountResourceKeyAccess = {
  primaryKeyId: () => Promise<string | null>
  resolve: (keyId: string) => Promise<CryptoKey>
}

/** Resolve a staged account DEK without exporting it or enrolling resource keys into the account keyring. */
const resolveAccountKey = async (keyId: string): Promise<CryptoKey> => {
  const [accountKey, wrappedKey] = await Promise.all([getAK(), getDEK(keyId)])
  if (!accountKey || !wrappedKey) {
    throw new Error('Account encryption keys are not available')
  }
  return unwrapDEK(wrappedKey, accountKey, keyId)
}

const accountKeys: AccountResourceKeyAccess = { primaryKeyId: getPrimaryKeyId, resolve: resolveAccountKey }

/** Keep the owner binding external to the stored record, so a server cannot relabel a private identity. */
const identityContext = (ownerId: string, keyId: string, accountKeyId: string): ScopedPayloadContext => ({
  ownerId,
  scopeId: `owner-resource-identity:${keyId}`,
  keyEpoch: 1,
  recordId: accountKeyId,
  purpose: 'owner-resource-private-identity',
})

/** Create the owner's public resource recipient and protect its private keys under the current account DEK. */
export const createOwnerResourceIdentity = async (
  ownerId: string,
  keys: AccountResourceKeyAccess = accountKeys,
): Promise<OwnerResourceIdentityRecord> => {
  const accountKeyId = await keys.primaryKeyId()
  if (!accountKeyId) {
    throw new Error('Account encryption must be initialized before creating a resource identity')
  }
  const key = await keys.resolve(accountKeyId)
  const identity = await generateResourceIdentity()
  return {
    version: 1,
    accountKeyId,
    publicKey: identity.publicKey,
    ciphertext: await encryptScopedJson(
      identity,
      key,
      identityContext(ownerId, identity.publicKey.keyId, accountKeyId),
    ),
  }
}

/** Open a persisted owner identity using its historical account DEK; AK rotation does not strand this record. */
export const openOwnerResourceIdentity = async (
  record: OwnerResourceIdentityRecord,
  ownerId: string,
  keys: AccountResourceKeyAccess = accountKeys,
): Promise<ResourceIdentity> => {
  if (record.version !== 1 || !record.accountKeyId) {
    throw new Error('Unsupported owner resource identity record')
  }
  const key = await keys.resolve(record.accountKeyId)
  const identity = parseResourceIdentity(
    await decryptScopedJson(
      record.ciphertext,
      key,
      identityContext(ownerId, record.publicKey.keyId, record.accountKeyId),
    ),
  )
  const [actual, expected] = await Promise.all([
    resourceIdentityFingerprint(identity.publicKey),
    resourceIdentityFingerprint(record.publicKey),
  ])
  if (actual !== expected) {
    throw new Error('Owner resource recipient does not match its encrypted private identity')
  }
  return identity
}
