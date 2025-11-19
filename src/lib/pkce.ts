/**
 * Generates a cryptographically secure code verifier for PKCE (Proof Key for Code Exchange)
 * @returns A URL-safe base64-encoded random string
 */
export const generateCodeVerifier = (): string => {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Generates a code challenge from a code verifier using SHA-256 hashing
 * @param verifier - The code verifier to hash
 * @returns A URL-safe base64-encoded SHA-256 hash of the verifier
 */
export const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
