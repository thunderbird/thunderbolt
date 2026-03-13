const storageKey = 'thunderbolt_encryption_key_state'

type EncryptionKeyState = 'NO_KEY' | 'KEY_PRESENT'

/** Get the current encryption key state from localStorage */
export const getEncryptionKeyState = (): EncryptionKeyState => {
  const state = localStorage.getItem(storageKey)
  return state === 'KEY_PRESENT' ? 'KEY_PRESENT' : 'NO_KEY'
}

/** Set the encryption key state in localStorage */
export const setEncryptionKeyState = (state: EncryptionKeyState) => {
  localStorage.setItem(storageKey, state)
}

/** Clear the encryption key from localStorage */
export const clearEncryptionKey = () => {
  localStorage.removeItem(storageKey)
}

/** Generate a fake 64-character hex recovery key */
export const generateFakeRecoveryKey = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
