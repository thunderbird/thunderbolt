/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * True when connecting to an MCP server failed because it demands OAuth
 * authorization (HTTP 401). Without an SDK `authProvider`, `@ai-sdk/mcp`
 * rejects with the raw transport error, not a closed-connection `MCPClientError`:
 *   - `StreamableHTTPError(401, ...)` or `SseError(401, ...)`: `code === 401`
 *   - `UnauthorizedError`: `name === 'UnauthorizedError'`
 *   - SSE POST fallback: a plain `Error` with `(HTTP 401)` in its message
 *
 * Match structurally instead of importing SDK classes: numeric `code`/`status`
 * fields are not a stable public type contract, and this helper is used during
 * startup before the MCP SDK loads. The proxy preserves the upstream status,
 * so the numeric match is primary. An `"error":"invalid_token"` response body
 * in the message is a fallback for layers that flatten the status off the error.
 * This signal puts the server card/dialog into its "needs-auth" state.
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
