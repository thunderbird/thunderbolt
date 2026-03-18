import { DecryptionError, EncryptionError } from './errors'
import { getMasterKey } from './master-key'
import { decrypt, encrypt, generateContentKey, unwrapContentKey, wrapContentKey } from './primitives'
import { fromBase64, toBase64 } from './utils'

export type EncryptedRecord = {
  version: 'v1'
  iv: string
  ciphertext: string
  wrappedContentKey: string
}

/**
 * Encrypt a plaintext payload. Fetches the master key internally.
 * Generates a fresh content key and IV for every call.
 */
export const encryptRecord = async (plaintext: string): Promise<EncryptedRecord> => {
  const masterKey = await getMasterKey()
  if (!masterKey) throw new EncryptionError('No master key available')

  const contentKey = await generateContentKey()
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const { iv, ciphertext } = await encrypt(contentKey, plaintextBytes)
  const wrappedContentKeyBytes = await wrapContentKey(masterKey, contentKey)

  return {
    version: 'v1',
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    wrappedContentKey: toBase64(wrappedContentKeyBytes),
  }
}

/**
 * Decrypt an EncryptedRecord. Fetches the master key internally.
 * Throws EncryptionError if master key is unavailable.
 * Throws DecryptionError if auth tag verification fails.
 */
export const decryptRecord = async (record: EncryptedRecord): Promise<string> => {
  const masterKey = await getMasterKey()
  if (!masterKey) throw new EncryptionError('No master key available')

  try {
    const wrappedKeyBytes = fromBase64(record.wrappedContentKey)
    const contentKey = await unwrapContentKey(masterKey, wrappedKeyBytes)
    const iv = fromBase64(record.iv)
    const ciphertext = fromBase64(record.ciphertext)
    const plaintextBytes = await decrypt(contentKey, iv, ciphertext)
    return new TextDecoder().decode(plaintextBytes)
  } catch (e) {
    if (e instanceof EncryptionError) throw e
    throw new DecryptionError(e instanceof Error ? e.message : 'Decryption failed')
  }
}
