/** Generate a new random AES-256-GCM master key (extractable: true) */
export const generateMasterKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'])

/**
 * Generate a new random AES-256-GCM content key.
 * Extractable so it can be wrapped by the master key via wrapKey.
 */
export const generateContentKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])

/** Encrypt plaintext with a key. Returns a fresh IV + ciphertext. */
export const encrypt = async (
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  return { iv, ciphertext }
}

/** Decrypt ciphertext with a key. Propagates DOMException on auth tag failure. */
export const decrypt = async (key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext))

/**
 * Wrap (encrypt) a content key using the master key via AES-GCM.
 * Returns IV (12 bytes) || wrapped key bytes.
 */
export const wrapContentKey = async (masterKey: CryptoKey, contentKey: CryptoKey): Promise<Uint8Array> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', contentKey, masterKey, { name: 'AES-GCM', iv }))
  const result = new Uint8Array(iv.length + wrapped.length)
  result.set(iv)
  result.set(wrapped, iv.length)
  return result
}

/**
 * Unwrap (decrypt) a wrapped content key using the master key.
 * Expects IV (12 bytes) || wrapped key bytes.
 */
export const unwrapContentKey = (masterKey: CryptoKey, wrappedKeyWithIv: Uint8Array): Promise<CryptoKey> => {
  const iv = wrappedKeyWithIv.slice(0, 12)
  const wrappedKey = wrappedKeyWithIv.slice(12)
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    masterKey,
    { name: 'AES-GCM', iv },
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Export a CryptoKey to raw bytes (only valid for extractable keys). */
export const exportKeyBytes = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey('raw', key))

/** Import raw bytes as an AES-256-GCM CryptoKey. */
export const importKeyBytes = (bytes: Uint8Array, extractable: boolean): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
    ...(extractable ? (['wrapKey', 'unwrapKey'] as const) : []),
  ])
