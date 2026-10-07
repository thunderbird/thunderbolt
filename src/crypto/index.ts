/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Primitives
export {
  generateKeyPair,
  generateMlKemKeyPair,
  generateAK,
  generateDEK,
  mintDEK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  deriveMlKemAtRestKey,
  wrapAK,
  rewrapAK,
  unwrapAK,
  wrapLegacyCK,
  type OpenedAkEnvelope,
  wrapDEK,
  unwrapDEK,
  rewrapKeyring,
  unwrapLegacyCK,
  importOrgPublicKey,
  wrapAKForOrg,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  uint8ArrayToBase64,
  base64ToUint8Array,
  type MlKemKeyPair,
  type EncryptedBytes,
} from './primitives'

// Canary + challenge-response signing, and the recovery key (seed <-> mnemonic,
// KDF -> recovery-slot keypair), are deliberately NOT re-exported at runtime:
// they pull ~44 KB (minified) of @noble P-256/BIP-39 code that no boot-path
// caller needs. Import them with `await import('@/crypto/canary')` /
// `await import('@/crypto/recovery-key')` inside the user-initiated flow that
// needs them (see src/services/encryption.ts) so the weight stays out of the
// entry bundle. Their types are free to re-export.
export type { RecoveryAnchor, SigningKeyPair } from './canary'

// Local witness to DEK "0"'s material — gates inbound AK adoption (THU-869)
export { anchorVersion, mintKeyringAnchor, keyringAnchorOpens, type KeyringAnchor } from './keyring-anchor'

// Device–session binding (client half of the sealed-nonce handshake)
export { openBindNonce } from './device-bind'

// Key storage (IndexedDB)
export {
  storeKeyPair,
  getKeyPair,
  storeAK,
  getAK,
  storeDEK,
  getDEK,
  getLegacyCK,
  stageWrappedDEKs,
  listDEKs,
  pruneStagedDEKs,
  storePrimaryKeyId,
  getPrimaryKeyId,
  storeKeyVersion,
  getKeyVersion,
  storeKeyringAnchor,
  getKeyringAnchor,
  clearAllKeys,
  type StoredKeyPair,
} from './key-storage'

// Errors
export { EncryptionError, DecryptionError, StorageError, ValidationError, KeyDerivationError } from './errors'
