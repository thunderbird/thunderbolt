/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildMcpHeaders, createMcpTransport, resolveMcpFetch } from './mcp-transport'

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

  // `@ai-sdk/mcp`'s `init()` writes the negotiated protocol via a direct `transport.protocolVersion =`
  // assignment, but the SDK's StreamableHTTPClientTransport exposes `protocolVersion` as a getter-only
  // accessor (write goes through `setProtocolVersion()`). Without the seam adapter this throws
  // `TypeError: Cannot set property protocolVersion ... which has only a getter` and breaks connect.
  // The casts model `@ai-sdk/mcp`'s untyped runtime write; the SDK types forbid it (read-only/absent).
  type MutableProtocol = { protocolVersion: string; setProtocolVersion: (v: string) => void }

  it('allows the http transport protocolVersion to be set by direct assignment (round-trips)', () => {
    const transport = createMcpTransport(url, 'http', cloudUrl, {}) as unknown as MutableProtocol
    expect(() => {
      transport.protocolVersion = '2025-06-18'
    }).not.toThrow()
    expect(transport.protocolVersion).toBe('2025-06-18')
  })

  it('routes the assignment through the SDK setProtocolVersion setter', () => {
    const transport = createMcpTransport(url, 'http', cloudUrl, {}) as unknown as MutableProtocol
    transport.setProtocolVersion('2024-11-05')
    expect(transport.protocolVersion).toBe('2024-11-05')
    transport.protocolVersion = '2025-06-18'
    expect(transport.protocolVersion).toBe('2025-06-18')
  })

  it('allows the sse transport protocolVersion to be set by direct assignment', () => {
    const transport = createMcpTransport(url, 'sse', cloudUrl, {}) as unknown as MutableProtocol
    expect(() => {
      transport.protocolVersion = '2025-06-18'
    }).not.toThrow()
    expect(transport.protocolVersion).toBe('2025-06-18')
  })
})

describe('resolveMcpFetch', () => {
  const bridgeUrl = 'http://127.0.0.1:9000/mcp'

  it('uses the native fetch directly for a loopback bridge URL (no proxy rewrite)', async () => {
    const native = mock(async () => new Response('ok'))
    const fetchFn = resolveMcpFetch(bridgeUrl, cloudUrl, native as unknown as typeof fetch)

    await fetchFn(bridgeUrl, { method: 'POST' })

    expect(native).toHaveBeenCalledTimes(1)
    // The bridge URL is passed through untouched — not rewritten to `${cloudUrl}/v1/proxy`.
    expect(native).toHaveBeenCalledWith(bridgeUrl, { method: 'POST' })
  })

  it('classifies an IPv6 loopback bridge URL as native', async () => {
    const native = mock(async () => new Response('ok'))
    const fetchFn = resolveMcpFetch('http://[::1]:9000/mcp', cloudUrl, native as unknown as typeof fetch)

    await fetchFn('http://[::1]:9000/mcp')

    expect(native).toHaveBeenCalledTimes(1)
  })

  it('routes a remote URL through the universal proxy (rewrites target to /proxy)', async () => {
    // The native seam must NOT be called for a remote target — the proxy fetch
    // owns that hop. We assert via globalThis.fetch capturing the rewritten request.
    const captured: Request[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      captured.push(input as Request)
      return new Response('ok')
    }) as unknown as typeof fetch
    const native = mock(async () => new Response('native'))

    try {
      const fetchFn = resolveMcpFetch(url, cloudUrl, native as unknown as typeof fetch)
      await fetchFn(url, { method: 'POST' })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(native).not.toHaveBeenCalled()
    expect(captured).toHaveLength(1)
    // createProxyFetch appends `/proxy` to the cloud base it's handed.
    expect(captured[0].url).toBe(`${cloudUrl}/proxy`)
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
