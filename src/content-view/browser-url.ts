/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Detect characters URL parsing would otherwise silently strip or reinterpret. */
const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/** Canonicalize a web address, rejecting non-web schemes and embedded control characters. */
export const normalizeBrowserUrl = (value: string): string | null => {
  if (hasControlCharacters(value)) {
    return null
  }

  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Resolve a complete HTTP(S) address or bare host; incomplete text cannot navigate. */
export const resolveBrowserInput = (value: string): string | null => {
  const input = value.trim()
  if (!input || hasControlCharacters(input)) {
    return null
  }
  if (/^https?:/i.test(input)) {
    return normalizeBrowserUrl(input)
  }
  if (input.startsWith('//')) {
    return normalizeBrowserUrl(`https:${input}`)
  }

  // A host with a numeric port also resembles a URI scheme (localhost:3000).
  const hostWithPort = /^(?:localhost|[^\s/:?#]+\.[^\s/:?#]+):\d+(?:[/?#]|$)/i.test(input)
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort) {
    return null
  }

  if (!/\s/.test(input)) {
    try {
      const url = new URL(`https://${input}`)
      const host = url.hostname
      if (!url.username && !url.password && (host === 'localhost' || host.includes('.') || host.startsWith('['))) {
        if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]') {
          url.protocol = 'http:'
        }
        return url.href
      }
    } catch {
      return null
    }
  }

  return null
}
