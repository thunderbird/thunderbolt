/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encrypt, decrypt } from '@/crypto'
import { getCK } from '@/crypto/key-storage'

const encPrefix = '__enc:'
export type EncryptionCodec = {
  encode: (plaintext: string) => Promise<string>
  decode: (encoded: string) => Promise<string>
}

// =============================================================================
// CK cache — lazy-loaded from IndexedDB, invalidated on sign-out/wipe.
// Works in both main thread and SharedWorker (both have indexedDB access).
//
// BroadcastChannel propagates invalidation across execution contexts (main thread,
// SharedWorker, other tabs) so a stale CK is never used after sign-out.
// =============================================================================

let cachedCK: CryptoKey | null = null
let e2eeSetupComplete = false

const ckChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('thunderbolt-ck-invalidation') : null

ckChannel?.addEventListener('message', (event: MessageEvent<'invalidate' | 'reset'>) => {
  cachedCK = null
  if (event.data === 'reset') {
    e2eeSetupComplete = false
  }
})

const getCachedCK = async (): Promise<CryptoKey | null> => {
  if (cachedCK) {
    return cachedCK
  }
  cachedCK = await getCK()
  if (cachedCK) {
    e2eeSetupComplete = true
  }
  return cachedCK
}

/** Clear the CK cache and broadcast to all contexts (SharedWorker, other tabs). */
export const invalidateCKCache = () => {
  cachedCK = null
  ckChannel?.postMessage('invalidate')
}

/** Full reset for sign-out/wipe: clears cache, broadcast, and setup flag. */
export const resetCodecState = () => {
  cachedCK = null
  e2eeSetupComplete = false
  ckChannel?.postMessage('reset')
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
      if (e2eeSetupComplete) {
        throw new Error('Content key unavailable after E2EE setup — refusing to encode plaintext')
      }
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

    // No recognized prefix — return as-is (plaintext)
    return encoded
  },
}
