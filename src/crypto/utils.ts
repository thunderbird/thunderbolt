/** Base64 encode a Uint8Array */
export const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

/** Base64 decode a string to Uint8Array */
export const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/** Encode a Uint8Array to lowercase hex string */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** Decode a hex string to Uint8Array */
export const fromHex = (hex: string): Uint8Array => {
  const result = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return result
}

/** Constant-time byte array comparison (prevents timing attacks on canary verification) */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}
