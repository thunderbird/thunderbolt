/** Check if a string is valid base64 */
export const isBase64 = (str: string): boolean => {
  if (!str || str.trim().length === 0) {
    return false
  }
  try {
    return btoa(atob(str)) === str
  } catch {
    return false
  }
}

/** Decode base64 string, returns original if not valid base64 */
export const decodeIfBase64 = (str: string): string => {
  if (!str) {
    return str
  }
  if (!isBase64(str)) {
    return str
  }
  try {
    return decodeURIComponent(escape(atob(str)))
  } catch {
    return str
  }
}

/** Base64 encode a string, returns original if already base64 */
export const encodeIfNotBase64 = (str: string): string => {
  if (!str) {
    return str
  }
  if (isBase64(str)) {
    return str
  }
  return btoa(unescape(encodeURIComponent(str)))
}
