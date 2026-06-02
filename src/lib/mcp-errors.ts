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
