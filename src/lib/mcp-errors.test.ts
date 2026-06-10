/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isClosedConnectionError } from './mcp-errors'

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
