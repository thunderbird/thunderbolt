const BASE64_PREFIX = 'b64:'

/** Check if a string was encoded by our codec (prefixed format). */
export const isBase64 = (str: string): boolean => {
  if (!str || str.trim().length === 0) {
    return false
  }
  return str.startsWith(BASE64_PREFIX)
}

/**
 * Decode a base64 string. Handles both prefixed (new) and unprefixed (legacy) formats.
 * Returns original if not valid base64.
 */
export const decodeIfBase64 = (str: string): string => {
  if (!str) {
    return str
  }

  // New prefixed format
  if (str.startsWith(BASE64_PREFIX)) {
    try {
      return decodeURIComponent(escape(atob(str.slice(BASE64_PREFIX.length))))
    } catch {
      return str
    }
  }

  // Legacy unprefixed format: try round-trip detection for backward compatibility
  try {
    if (btoa(atob(str)) === str) {
      return decodeURIComponent(escape(atob(str)))
    }
  } catch {
    // not base64
  }

  return str
}

/** Base64 encode a string with prefix. Returns original if already encoded. */
export const encodeIfNotBase64 = (str: string): string => {
  if (!str) {
    return str
  }
  if (str.startsWith(BASE64_PREFIX)) {
    return str
  }
  return BASE64_PREFIX + btoa(unescape(encodeURIComponent(str)))
}
