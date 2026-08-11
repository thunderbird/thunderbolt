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
  wrapDEK,
  unwrapDEK,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  uint8ArrayToBase64,
  base64ToUint8Array,
  type MlKemKeyPair,
  type EncryptedBytes,
} from './primitives'

// Canary + challenge-response signing
export {
  canaryAAD,
  createCanary,
  verifyCanary,
  deriveSigningKeyPair,
  signChallenge,
  type SigningKeyPair,
} from './canary'

// Recovery key (seed <-> mnemonic, KDF -> AK)
export {
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  deriveAKFromSeed,
  generateKdfSalt,
} from './recovery-key'

// Key storage (IndexedDB)
export {
  storeKeyPair,
  getKeyPair,
  storeAK,
  getAK,
  storeWrappedDEK,
  getWrappedDEK,
  stageWrappedDEKs,
  listWrappedDEKs,
  storePrimaryKeyId,
  getPrimaryKeyId,
  storeKeyVersion,
  getKeyVersion,
  clearAllKeys,
  type StoredKeyPair,
} from './key-storage'

// Errors
export { EncryptionError, DecryptionError, StorageError, ValidationError, KeyDerivationError } from './errors'
