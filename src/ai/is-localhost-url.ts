/**
 * Returns true when the URL points to a loopback / local address that the
 * backend proxy cannot reach (the backend runs in a different network
 * namespace from the user's machine).
 *
 * Covers: localhost, 127.x.x.x, ::1, and 0.0.0.0.
 */
export const isLocalhostUrl = (url: string): boolean => {
  try {
    const { hostname } = new URL(url)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('127.') ||
      hostname === '::1' ||
      hostname === '0.0.0.0'
    )
  } catch {
    return false
  }
}
