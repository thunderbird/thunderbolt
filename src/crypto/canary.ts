import { encrypt, decrypt } from './primitives'
import { DecryptionError } from './errors'

const canaryPlaintext = 'thunderbolt-canary-v1'

type Canary = {
  canaryIv: string
  canaryCtext: string
}

/** Create a canary by encrypting a known plaintext with CK. */
export const createCanary = async (ck: CryptoKey): Promise<Canary> => {
  const { iv, ciphertext } = await encrypt(canaryPlaintext, ck)
  return { canaryIv: iv, canaryCtext: ciphertext }
}

/**
 * Verify a recovery key by decrypting the canary and comparing to the known plaintext.
 * Returns `true` if the key is correct, `false` if decryption fails or plaintext doesn't match.
 */
export const verifyCanary = async (ck: CryptoKey, canaryIv: string, canaryCtext: string): Promise<boolean> => {
  try {
    const decrypted = await decrypt({ iv: canaryIv, ciphertext: canaryCtext }, ck)
    return decrypted === canaryPlaintext
  } catch (err) {
    if (err instanceof DecryptionError) {
      return false
    }
    throw err
  }
}
