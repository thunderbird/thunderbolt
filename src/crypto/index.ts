// Error types
export { DecryptionError, EncryptionError, NotImplementedError, StorageError, ValidationError } from './errors'

// Utilities
export { bytesEqual, fromBase64, fromHex, toBase64, toHex } from './utils'

// Key storage
export type { KeyStorage } from './key-storage'
export { LocalStorageAdapter, keyStorage } from './key-storage'

// Crypto primitives
export {
  decrypt,
  encrypt,
  exportKeyBytes,
  generateContentKey,
  generateMasterKey,
  importKeyBytes,
  unwrapContentKey,
  wrapContentKey,
} from './primitives'

// Key derivation
export { decodeRecoveryKey, deriveKeyFromPassphrase, encodeRecoveryKey, generateSalt } from './key-derivation'

// Master key manager
export {
  KeyState,
  clearMasterKey,
  exportMasterKeyBytes,
  getKeyState,
  getMasterKey,
  getSalt,
  getStartupAction,
  hasMasterKey,
  setMasterKey,
  setSalt,
} from './master-key'

// Key canary
export type { KeyCanary } from './canary'
export { createCanary, verifyCanary } from './canary'

// Envelope encryption
export type { EncryptedRecord } from './envelope'
export { decryptRecord, encryptRecord } from './envelope'

// Recovery key display
export { formatRecoveryKeyForDisplay } from './format'

// Key setup service
export type { KeySetupResult } from './key-setup'
export { createNewKey, importFromPassphrase, importFromRecoveryKey } from './key-setup'

// Sync gate
export type { EnableSyncResult } from './sync-gate'
export { SyncState, disableSync, enableSync, getSyncState, onSyncEnabled } from './sync-gate'

// Migration
export type { MigrationStatus } from './migration'
export { migrateLocalData } from './migration'
