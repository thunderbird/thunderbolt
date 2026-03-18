import { decrypt, encrypt } from './primitives'
import { bytesEqual, fromBase64, toBase64 } from './utils'

const CANARY_PLAINTEXT = 'thunderbolt-key-check-v1'

export type KeyCanary = {
  version: 'v1'
  iv: string
  ciphertext: string
}

/**
 * Encrypt CANARY_PLAINTEXT with the given master key.
 * Returns a serialisable canary blob for upload to the server.
 */
export const createCanary = async (masterKey: CryptoKey): Promise<KeyCanary> => {
  const plaintext = new TextEncoder().encode(CANARY_PLAINTEXT)
  const { iv, ciphertext } = await encrypt(masterKey, plaintext)
  return {
    version: 'v1',
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  }
}

/**
 * Decrypt the canary blob with the given master key and check the plaintext.
 * Returns true if decryption succeeds and plaintext matches CANARY_PLAINTEXT.
 * Returns false (does NOT throw) if decryption fails — wrong key.
 */
export const verifyCanary = async (masterKey: CryptoKey, canary: KeyCanary): Promise<boolean> => {
  try {
    const iv = fromBase64(canary.iv)
    const ciphertext = fromBase64(canary.ciphertext)
    const decrypted = await decrypt(masterKey, iv, ciphertext)
    const expected = new TextEncoder().encode(CANARY_PLAINTEXT)
    return bytesEqual(decrypted, expected)
  } catch {
    return false
  }
}
