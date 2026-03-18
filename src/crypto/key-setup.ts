import { createCanary, verifyCanary } from './canary'
import type { KeyCanary } from './canary'
import { ValidationError } from './errors'
import { decodeRecoveryKey, deriveKeyFromPassphrase, encodeRecoveryKey, generateSalt } from './key-derivation'
import { keyStorage } from './key-storage'
import { getMasterKey, getSalt, setMasterKey, setSalt } from './master-key'
import { exportKeyBytes, generateMasterKey, importKeyBytes } from './primitives'
import { toBase64 } from './utils'

export type KeySetupResult =
  | { success: true }
  | { success: false; error: 'WRONG_KEY' | 'INVALID_FORMAT' | 'SERVER_ERROR' | 'NETWORK_ERROR' }

/**
 * Create a brand-new master key.
 * If passphrase is provided, derives key via PBKDF2 and stores the salt.
 * If passphrase is omitted, generates a random key.
 * Returns the recovery key hex string for display.
 */
export const createNewKey = async (
  passphrase?: string,
): Promise<{ result: KeySetupResult; recoveryKey: string }> => {
  let masterKey: CryptoKey

  if (passphrase) {
    const salt = generateSalt()
    masterKey = await deriveKeyFromPassphrase(passphrase, salt)
    setSalt(salt)
  } else {
    masterKey = await generateMasterKey()
  }

  const keyBytes = await exportKeyBytes(masterKey)
  await setMasterKey(keyBytes)

  const canary = await createCanary(masterKey)
  // Store canary locally for verification on import flows
  keyStorage.set('thunderbolt_enc_canary', JSON.stringify(canary))

  // TODO: Upload { canary, salt } to server when backend endpoints exist
  // await api.post('/api/encryption/setup', { canary, salt: salt ? toBase64(salt) : '' })

  const recoveryKey = encodeRecoveryKey(keyBytes)
  return { result: { success: true }, recoveryKey }
}

/**
 * Import a key by re-deriving from passphrase.
 * Fetches the salt from local storage (server fetch stubbed), derives the key, verifies canary.
 */
export const importFromPassphrase = async (passphrase: string): Promise<KeySetupResult> => {
  // TODO: Fetch salt and canary from server when backend endpoints exist
  // const { salt, canary } = await api.get('/api/encryption/setup')
  const salt = getSalt()
  if (!salt) return { success: false, error: 'WRONG_KEY' }

  const canaryJson = keyStorage.get('thunderbolt_enc_canary')
  if (!canaryJson) return { success: false, error: 'WRONG_KEY' }

  const canary: KeyCanary = JSON.parse(canaryJson)
  const masterKey = await deriveKeyFromPassphrase(passphrase, salt)
  const isValid = await verifyCanary(masterKey, canary)

  if (!isValid) return { success: false, error: 'WRONG_KEY' }

  const keyBytes = await exportKeyBytes(masterKey)
  await setMasterKey(keyBytes)
  setSalt(salt)
  return { success: true }
}

/**
 * Import a key from a 64-char hex recovery key.
 * Decodes hex, imports key, verifies canary against stored canary.
 */
export const importFromRecoveryKey = async (hexKey: string): Promise<KeySetupResult> => {
  let keyBytes: Uint8Array
  try {
    keyBytes = decodeRecoveryKey(hexKey)
  } catch (e) {
    if (e instanceof ValidationError) return { success: false, error: 'INVALID_FORMAT' }
    throw e
  }

  const masterKey = await importKeyBytes(keyBytes, true)

  const canaryJson = keyStorage.get('thunderbolt_enc_canary')
  if (!canaryJson) {
    // No canary stored — first import, just store the key
    await setMasterKey(keyBytes)
    const canary = await createCanary(masterKey)
    keyStorage.set('thunderbolt_enc_canary', JSON.stringify(canary))
    return { success: true }
  }

  const canary: KeyCanary = JSON.parse(canaryJson)
  const isValid = await verifyCanary(masterKey, canary)
  if (!isValid) return { success: false, error: 'WRONG_KEY' }

  await setMasterKey(keyBytes)
  return { success: true }
}
