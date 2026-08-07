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

/** Close code (app-defined 4000–4999 range) emitted when a server accepts the
 *  WebSocket upgrade but then refuses the socket, so the client distinguishes
 *  "the server refused me" (re-login flow) from "I never reached the server"
 *  (network-error toast). Shared by the backend WS routes and the cloud
 *  runner — the client's reconnect logic keys on the exact value. */
export const wsCloseUnauthorized = 4001

/** Encode a raw bearer token to an RFC 6455 subprotocol-safe base64url string.
 *
 *  Deliberately avoids `Buffer`: bundlers can inject the npm `buffer` polyfill
 *  as a global (the Tauri webview does), and that polyfill rejects the
 *  `base64url` encoding — a `typeof Buffer` branch would throw at runtime on
 *  exactly those platforms. `btoa`/`atob` + `TextEncoder` exist natively in
 *  every runtime this module targets (browsers, Bun, Node ≥ 16). */
export const encodeWsBearer = (token: string): string => {
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

/**
 * Extract and decode the bearer token from a comma-separated
 * `Sec-WebSocket-Protocol` value. Returns `null` when no decodable bearer
 * entry is present. Shared by every server that terminates the subprotocol
 * scheme (backend WS routes, cloud runner).
 */
export const extractBearerSubprotocol = (header: string | null): string | null => {
  if (!header) {
    return null
  }
  for (const raw of header.split(',')) {
    const entry = raw.trim()
    if (entry.startsWith(wsBearerSubprotocolPrefix)) {
      return decodeWsBearer(entry.slice(wsBearerSubprotocolPrefix.length))
    }
  }
  return null
}
