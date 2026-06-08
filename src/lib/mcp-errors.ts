/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * True when `err` is the `@ai-sdk/mcp` error that fires after the underlying
 * transport has dropped. The SDK rejects subsequent requests with an
 * `MCPClientError` carrying one of two messages — verified against
 * `@ai-sdk/mcp/dist/index.js`:
 *   - "Attempted to send a request from a closed client" (request from a
 *     closed client, index.js:1814-1818)
 *   - "Connection closed" (in-flight handlers rejected on close, index.js:2177-2187)
 *
 * The class constant is `AI_MCPClientError`, but that name is only used for the
 * marker symbol — the constructor defaults the instance `name` to
 * `'MCPClientError'` and never overrides it, so a thrown instance's `err.name`
 * is `'MCPClientError'` at runtime (confirmed by exercising the real SDK).
 * `MCPClientError` is not exported in the package's `.d.ts`, so we match on the
 * name/message rather than an `instanceof` check. This is the reliable drop
 * signal at the `tools()` boundary, so a reconnect can be attempted.
 */
export const isClosedConnectionError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const { name, message } = err as { name?: unknown; message?: unknown }
  return name === 'MCPClientError' && typeof message === 'string' && /closed client|Connection closed/i.test(message)
}

/**
 * True when connecting to an MCP server failed because the server demands OAuth
 * authorization (HTTP 401). We connect without an SDK `authProvider`, so a 401
 * surfaces as the raw transport error from `@modelcontextprotocol/sdk` — not a
 * closed-connection `MCPClientError`. Verified against the SDK transports:
 *   - `StreamableHTTPError(401, ...)` (`code === 401`, streamableHttp.js:364)
 *   - `SseError(401, ...)` (`code === 401`, sse.js:93)
 *   - `UnauthorizedError` (`name === 'UnauthorizedError'`, auth.js:7) thrown
 *     when auth is required but no provider is configured
 *   - SSE POST fallback: a plain `Error` whose message embeds `(HTTP 401)`
 *     (sse.js:192)
 * The `code`/`status` numbers are not in the public `.d.ts` as a stable contract,
 * so we match on the structural `code === 401` plus the name/message fallbacks
 * rather than `instanceof`. This is the needs-authorization signal the server
 * card/dialog reads to switch a server to its "needs-auth" state.
 *
 * Verified end-to-end against the real failure: connecting to an OAuth server
 * without a token throws (un-wrapped by `@ai-sdk/mcp`, whose `request()` rejects
 * with the raw transport error — index.js:1856) a
 * `StreamableHTTPError(401, 'Error POSTing to endpoint: {"error":"invalid_token",…}')`
 * (streamableHttp.js:312-364). The proxy preserves the upstream status, so
 * `code === 401` is the primary match; the `invalid_token` body match below is a
 * belt-and-suspenders fallback should a layer ever flatten the status off the
 * error.
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
