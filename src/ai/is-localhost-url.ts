/**
 * Determines whether a URL's hostname refers to a loopback / localhost address.
 *
 * Matches:
 *   - `localhost`
 *   - `*.localhost` (WHATWG-spec subdomains, e.g. `my.localhost`)
 *   - `127.x.x.x` (entire 127.0.0.0/8 block)
 *   - `::1` and `[::1]` (IPv6 loopback)
 *   - `0.0.0.0`
 *
 * Intentionally does NOT match RFC-1918 private ranges (10.*, 172.16.*, 192.168.*).
 * Those should be blocked by the backend's SSRF guard, not short-circuited here.
 *
 * @param urlStr - A fully-qualified URL string (e.g. "http://localhost:11434/v1").
 * @returns `true` when the hostname is loopback/localhost, `false` otherwise or on parse error.
 */
export const isLocalhostUrl = (urlStr: string): boolean => {
  let hostname: string
  try {
    hostname = new URL(urlStr).hostname
  } catch {
    return false
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true
  }

  if (hostname === '::1' || hostname === '[::1]') {
    return true
  }

  if (hostname === '0.0.0.0') {
    return true
  }

  // 127.0.0.0/8 — new URL() normalises "127.1" → "127.0.0.1" for us.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true
  }

  return false
}
