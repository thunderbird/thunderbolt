/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isClosedConnectionError, isUnauthorizedError } from './mcp-errors'

/** Mirror the `MCPClientError` shape the SDK throws (name + message), verified
 *  by exercising the real `@ai-sdk/mcp` client: the instance `name` is
 *  `'MCPClientError'`, not the `AI_MCPClientError` marker constant. */
const mcpError = (message: string) => Object.assign(new Error(message), { name: 'MCPClientError' })

describe('isClosedConnectionError', () => {
  const cases: Array<{ name: string; err: unknown; expected: boolean }> = [
    {
      name: 'request from a closed client (index.js:1814-1818)',
      err: mcpError('Attempted to send a request from a closed client'),
      expected: true,
    },
    {
      name: 'connection closed (index.js:2177-2187)',
      err: mcpError('Connection closed'),
      expected: true,
    },
    {
      name: 'connection closed — case-insensitive',
      err: mcpError('connection closed'),
      expected: true,
    },
    {
      name: 'MCPClientError with an unrelated message',
      err: mcpError('Server does not support tools'),
      expected: false,
    },
    {
      name: 'plain Error with a matching message but wrong name',
      err: new Error('Connection closed'),
      expected: false,
    },
    {
      name: 'network TypeError',
      err: new TypeError('Failed to fetch'),
      expected: false,
    },
    { name: 'null', err: null, expected: false },
    { name: 'undefined', err: undefined, expected: false },
    { name: 'string', err: 'Connection closed', expected: false },
    { name: 'object with non-string message', err: { name: 'MCPClientError', message: 42 }, expected: false },
  ]

  for (const { name, err, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isClosedConnectionError(err)).toBe(expected)
    })
  }
})

/** Mirror `StreamableHTTPError`/`SseError` (a numeric `code` carries the HTTP
 *  status) — verified against the SDK constructors in streamableHttp.js:12-17
 *  and sse.js:5-11. We connect without an SDK authProvider, so a 401 surfaces
 *  as one of these raw transport errors. */
const transportError = (label: string, code: number, message: string) =>
  Object.assign(new Error(`${label}: ${message}`), { code })

/** SDK `UnauthorizedError` (auth.js:7) — thrown when auth is required but no
 *  provider is configured; its `name` is the class name and message defaults to
 *  `'Unauthorized'`. */
const unauthorizedError = () => Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' })

/** Reconstructs the exact error the SDK throws on a no-auth 401, verified
 *  against `StreamableHTTPClientTransport.send` (streamableHttp.js:312-364): with
 *  NO authProvider the 401 branch is skipped and it throws
 *  `new StreamableHTTPError(response.status, 'Error POSTing to endpoint: ${text}')`
 *  where `text` is the raw 401 body. `@ai-sdk/mcp` rejects with this un-wrapped
 *  (index.js:1856). This is the precise shape the user hit on Test Connection
 *  against an OAuth server with no token. */
class StreamableHTTPError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(`Streamable HTTP error: ${message}`)
    this.code = code
  }
}
const realNoAuth401 = () =>
  new StreamableHTTPError(
    401,
    'Error POSTing to endpoint: {"error":"invalid_token","error_description":"Missing or invalid access token"}',
  )

describe('isUnauthorizedError', () => {
  const cases: Array<{ name: string; err: unknown; expected: boolean }> = [
    {
      name: 'real SDK StreamableHTTPError(401) with invalid_token body (the user-hit error)',
      err: realNoAuth401(),
      expected: true,
    },
    {
      name: 'StreamableHTTPError invalid_token body even if status is flattened off',
      err: new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Missing or invalid access token"}',
      ),
      expected: true,
    },
    {
      name: 'StreamableHTTPError with code 401 (streamableHttp.js:364)',
      err: transportError('Streamable HTTP error', 401, 'Error POSTing to endpoint: <body>'),
      expected: true,
    },
    {
      name: 'SseError with code 401 (sse.js:93)',
      err: transportError('SSE error', 401, 'unauthorized'),
      expected: true,
    },
    {
      name: 'SDK UnauthorizedError (auth.js:7)',
      err: unauthorizedError(),
      expected: true,
    },
    {
      name: 'SSE POST fallback plain Error embedding (HTTP 401) (sse.js:192)',
      err: new Error('Error POSTing to endpoint (HTTP 401): denied'),
      expected: true,
    },
    {
      name: 'error carrying a numeric status of 401',
      err: Object.assign(new Error('nope'), { status: 401 }),
      expected: true,
    },
    {
      name: 'closed-connection MCPClientError is NOT needs-auth',
      err: mcpError('Connection closed'),
      expected: false,
    },
    {
      name: 'request-from-closed-client MCPClientError is NOT needs-auth',
      err: mcpError('Attempted to send a request from a closed client'),
      expected: false,
    },
    {
      name: 'a 403 (insufficient scope) is NOT a 401',
      err: transportError('Streamable HTTP error', 403, 'forbidden'),
      expected: false,
    },
    {
      name: 'a 500 transport error is NOT needs-auth',
      err: transportError('Streamable HTTP error', 500, 'boom'),
      expected: false,
    },
    {
      name: 'unrelated message containing the digits 401 (e.g. a port) does not match',
      err: new Error('connect ECONNREFUSED 127.0.0.1:8401'),
      expected: false,
    },
    { name: 'network TypeError', err: new TypeError('Failed to fetch'), expected: false },
    { name: 'null', err: null, expected: false },
    { name: 'undefined', err: undefined, expected: false },
    { name: 'string', err: 'Unauthorized', expected: false },
  ]

  for (const { name, err, expected } of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(isUnauthorizedError(err)).toBe(expected)
    })
  }
})
