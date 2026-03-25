/**
 * Returns true if the string is valid base64 (non-empty, decodable).
 * Uses try/catch around atob(); refactor later for format checks or encryption markers.
 */
export const isValidBase64 = (value: string): boolean => {
  if (typeof value !== 'string' || value.length === 0) {
    return false
  }
  try {
    atob(value)
    return true
  } catch {
    return false
  }
}

/**
 * If valid base64, returns decoded string; otherwise returns original.
 */
export const decodeIfValidBase64 = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return value
  }
  try {
    return atob(value)
  } catch {
    return value
  }
}

/**
 * Encodes a string to base64.
 */
export const encodeToBase64 = (value: string): string => btoa(value)
