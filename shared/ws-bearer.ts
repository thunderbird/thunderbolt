/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract for WebSocket bearer-token authentication, shared by the
 * backend WS routes (`backend/src/auth/ws-bearer-auth.ts`) and the frontend
 * transports (`src/acp/transports/index.ts`, `src/lib/proxy-fetch.ts`).
 *
 * Browsers can't set an `Authorization` header on `new WebSocket()`. The only
 * handshake-time channels are the URL (logged everywhere) and
 * `Sec-WebSocket-Protocol` (logged nowhere by default). We carry the same
 * signed bearer token the REST channel uses as a subprotocol entry.
 *
 * The raw Better Auth bearer is `<sessionToken>.<base64Signature>`, which
 * contains `.`, `+`, `/`, and `=` — none of which are valid in an RFC 6455
 * subprotocol token. We therefore base64url-encode the whole bearer for
 * transport and decode it server-side before validation. Drift between the two
 * ends is silent breakage, so the prefix and codec live in one place.
 */

/** Bearer subprotocol entries start with this prefix; the rest is the base64url-encoded token. */
export const wsBearerSubprotocolPrefix = 'thunderbolt.bearer.'

/** Encode a raw bearer token to an RFC 6455 subprotocol-safe base64url string. */
export const encodeWsBearer = (token: string): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(token, 'utf-8').toString('base64url')
  }
  const bytes = new TextEncoder().encode(token)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a base64url-encoded bearer subprotocol entry back to the raw token.
 *  Returns null when the payload is empty or not valid base64url. */
export const decodeWsBearer = (encoded: string): string | null => {
  if (!encoded) {
    return null
  }
  if (typeof Buffer !== 'undefined') {
    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf-8')
      return decoded || null
    } catch {
      return null
    }
  }
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(normalized)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)
    return decoded || null
  } catch {
    return null
  }
}
