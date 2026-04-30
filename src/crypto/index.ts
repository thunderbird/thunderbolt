/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Primitives
export {
  generateKeyPair,
  generateMlKemKeyPair,
  generateCK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  wrapCK,
  rewrapCK,
  unwrapCK,
  encrypt,
  decrypt,
  type MlKemKeyPair,
} from './primitives'

// Canary
export { createCanary, verifyCanary } from './canary'

// Recovery key
export { encodeRecoveryKey, decodeRecoveryKey } from './recovery-key'

// Key storage (IndexedDB)
export { storeKeyPair, getKeyPair, storeCK, getCK, clearCK, clearAllKeys, type StoredKeyPair } from './key-storage'

// Errors
export { EncryptionError, DecryptionError, StorageError, ValidationError } from './errors'
