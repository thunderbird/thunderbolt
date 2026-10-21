/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Recognize the HTTP 401 errors emitted by MCP transports without loading their
 * SDK classes. The numeric code/status survives the proxy; name and message
 * fallbacks cover SDK auth errors and the SSE POST fallback's plain Error.
 */
export const isUnauthorizedError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const { name, code, status, message } = err as {
    name?: unknown
    code?: unknown
    status?: unknown
    message?: unknown
  }
  if (code === 401 || status === 401) {
    return true
  }
  if (name === 'UnauthorizedError') {
    return true
  }
  return (
    typeof message === 'string' &&
    (/\bHTTP 401\b|\b401 Unauthorized\b/i.test(message) || /"error"\s*:\s*"invalid_token"/i.test(message))
  )
}
