import { encrypt, decrypt, getCK } from '@/crypto'

const encPrefix = '__enc:'
const legacyB64Prefix = 'b64:'

export type EncryptionCodec = {
  encode: (plaintext: string) => Promise<string>
  decode: (encoded: string) => Promise<string>
}

// =============================================================================
// CK cache — lazy-loaded from IndexedDB, invalidated on sign-out/wipe.
// Works in both main thread and SharedWorker (both have indexedDB access).
//
// TODO: In SharedWorker mode, this is a separate module instance from the main thread.
// invalidateCKCache() on sign-out doesn't reach the worker's cache. The worker will
// reload from IndexedDB (which is cleared) on next getCK(), but there's a brief window
// where stale CK could be used. Consider postMessage-based invalidation.
// =============================================================================

let cachedCK: CryptoKey | null = null

const getCachedCK = async (): Promise<CryptoKey | null> => {
  if (cachedCK) {
    return cachedCK
  }
  cachedCK = await getCK()
  return cachedCK
}

/** Clear the CK cache. Call on sign-out or full wipe so the codec reloads. */
export const invalidateCKCache = () => {
  cachedCK = null
}

// =============================================================================
// AES-GCM codec
// =============================================================================

/** AES-256-GCM codec using CK from IndexedDB. Passes through when CK is unavailable. */
export const codec: EncryptionCodec = {
  async encode(plaintext: string): Promise<string> {
    if (plaintext.startsWith(encPrefix)) {
      return plaintext
    }
    const ck = await getCachedCK()
    if (!ck) {
      return plaintext
    }
    const { iv, ciphertext } = await encrypt(plaintext, ck)
    return `${encPrefix}${iv}:${ciphertext}`
  },

  async decode(encoded: string): Promise<string> {
    // AES-GCM encrypted format: __enc:<iv>:<ciphertext>
    if (encoded.startsWith(encPrefix)) {
      const payload = encoded.slice(encPrefix.length)
      const separatorIdx = payload.indexOf(':')
      if (separatorIdx === -1) {
        return encoded
      }
      const iv = payload.slice(0, separatorIdx)
      const ciphertext = payload.slice(separatorIdx + 1)

      const ck = await getCachedCK()
      if (!ck) {
        return encoded
      }

      try {
        return await decrypt({ iv, ciphertext }, ck)
      } catch (err) {
        console.warn('[codec] Decryption failed, returning raw value:', err)
        return encoded
      }
    }

    // Legacy base64 format: b64:<base64> (backward compat with 6.1 PoC data)
    if (encoded.startsWith(legacyB64Prefix)) {
      try {
        return decodeURIComponent(escape(atob(encoded.slice(legacyB64Prefix.length))))
      } catch {
        return encoded
      }
    }

    // No recognized prefix — return as-is (plaintext)
    return encoded
  },
}
