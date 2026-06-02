/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildMcpHeaders, createMcpTransport } from './mcp-transport'

const url = 'https://mcp.example.com/server'
const cloudUrl = 'https://cloud.example.com'

describe('createMcpTransport', () => {
  it('returns an SSEClientTransport for the "sse" type', () => {
    const transport = createMcpTransport(url, 'sse', cloudUrl, {})
    expect(transport).toBeInstanceOf(SSEClientTransport)
  })

  it('returns a StreamableHTTPClientTransport for the "http" type', () => {
    const transport = createMcpTransport(url, 'http', cloudUrl, {})
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })
})

describe('buildMcpHeaders', () => {
  it('sets a plain Bearer Authorization header when a token is provided', () => {
    const headers = buildMcpHeaders('tok')
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers.Accept).toBe('application/json, text/event-stream')
  })

  it('omits Authorization but keeps Accept when no token is provided', () => {
    const headers = buildMcpHeaders()
    expect(headers.Authorization).toBeUndefined()
    expect(headers.Accept).toBe('application/json, text/event-stream')
  })
})
