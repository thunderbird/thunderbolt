import { keyStorage } from './key-storage'
import { exportKeyBytes, importKeyBytes } from './primitives'
import { fromBase64, toBase64 } from './utils'

const STORAGE_KEYS = {
  encKey: 'thunderbolt_enc_key',
  encSalt: 'thunderbolt_enc_salt',
  encVersion: 'thunderbolt_enc_version',
  keyState: 'thunderbolt_key_state',
} as const

export const KeyState = {
  NO_KEY: 'NO_KEY',
  KEY_PRESENT: 'KEY_PRESENT',
  KEY_LOCKED: 'KEY_LOCKED',
} as const

export type KeyState = (typeof KeyState)[keyof typeof KeyState]

let _cachedKey: CryptoKey | null = null

/**
 * Load the master key from storage and import it into SubtleCrypto.
 * Caches the imported CryptoKey for the session.
 */
export const getMasterKey = async (): Promise<CryptoKey | null> => {
  if (_cachedKey) return _cachedKey

  const b64 = keyStorage.get(STORAGE_KEYS.encKey)
  if (!b64) return null

  const keyBytes = fromBase64(b64)
  _cachedKey = await importKeyBytes(keyBytes, true)
  return _cachedKey
}

/**
 * Persist a new master key. Accepts raw bytes.
 * Clears the session cache — forces re-import on next getMasterKey() call.
 */
export const setMasterKey = async (keyBytes: Uint8Array): Promise<void> => {
  keyStorage.set(STORAGE_KEYS.encKey, toBase64(keyBytes))
  keyStorage.set(STORAGE_KEYS.encVersion, 'v1')
  keyStorage.set(STORAGE_KEYS.keyState, KeyState.KEY_PRESENT)
  _cachedKey = null
}

/** Persist the PBKDF2 salt alongside the master key. */
export const setSalt = (salt: Uint8Array): void => {
  keyStorage.set(STORAGE_KEYS.encSalt, toBase64(salt))
}

/** Retrieve the stored PBKDF2 salt, or null if none. */
export const getSalt = (): Uint8Array | null => {
  const b64 = keyStorage.get(STORAGE_KEYS.encSalt)
  return b64 ? fromBase64(b64) : null
}

/** Remove the master key from storage and clear the session cache. */
export const clearMasterKey = (): void => {
  keyStorage.clear()
  _cachedKey = null
}

/**
 * Synchronous check — returns true for both KEY_PRESENT and KEY_LOCKED.
 * Returns false only for NO_KEY.
 */
export const hasMasterKey = (): boolean => {
  const state = keyStorage.get(STORAGE_KEYS.keyState)
  return state === KeyState.KEY_PRESENT || state === KeyState.KEY_LOCKED
}

/** Returns the current key state. Synchronous — reads from localStorage. */
export const getKeyState = (): KeyState => {
  const state = keyStorage.get(STORAGE_KEYS.keyState)
  if (state === KeyState.KEY_PRESENT) return KeyState.KEY_PRESENT
  if (state === KeyState.KEY_LOCKED) return KeyState.KEY_LOCKED
  return KeyState.NO_KEY
}

/**
 * Called on every app startup before rendering any UI.
 * - "READY" — key is present and usable
 * - "NO_KEY" — no key set up
 * - "REQUIRES_UNLOCK" — KEY_LOCKED state (Phase 3)
 */
export const getStartupAction = (): 'READY' | 'NO_KEY' | 'REQUIRES_UNLOCK' => {
  const state = getKeyState()
  if (state === KeyState.KEY_PRESENT) return 'READY'
  if (state === KeyState.KEY_LOCKED) return 'REQUIRES_UNLOCK'
  return 'NO_KEY'
}

/**
 * Export the current master key as raw bytes.
 * Returns null if no key is available.
 */
export const exportMasterKeyBytes = async (): Promise<Uint8Array | null> => {
  const key = await getMasterKey()
  if (!key) return null
  return exportKeyBytes(key)
}

/** Clear the in-memory session cache only (for testing). */
export const _clearCache = (): void => {
  _cachedKey = null
}
