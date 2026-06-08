/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract for WebSocket bearer-token authentication and the carrier
 * subprotocol that frames it, shared by the backend WS routes
 * (`backend/src/auth/ws-bearer-auth.ts`, `backend/src/proxy/ws.ts`,
 * `backend/src/haystack/routes.ts`) and the frontend transports
 * (`src/acp/transports/index.ts`, `src/lib/proxy-fetch.ts`).
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
 * ends is silent breakage, so the prefix, carrier, and codec live in one place.
 */

/**
 * Carrier subprotocol the client offers alongside the bearer and the server
 * echoes back as `Sec-WebSocket-Protocol`, satisfying RFC 6455 (the server must
 * pick one offered subprotocol) so strict clients (browsers, Bun) accept the
 * upgrade. The auth-bearing bearer entry is never echoed. The value must match
 * byte-for-byte on both ends — drift is silent breakage — so it lives here.
 */
export const wsCarrierSubprotocol = 'thunderbolt.v1'

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
