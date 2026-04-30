/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpTransport } from './mcp-provider'
import { TauriStreamableHTTPClientTransport } from './tauri-http-transport'

describe('createMcpTransport', () => {
  const target = 'https://mcp.example.com/'

  it('uses the standard StreamableHTTP transport when the URL was rewritten by the proxy', () => {
    const proxied = `http://localhost:8000/v1/proxy/${encodeURIComponent(target)}`
    const transport = createMcpTransport(target, proxied)
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    // It should NOT be the Tauri-fetch variant — same-origin proxy works with browser fetch.
    expect(transport).not.toBeInstanceOf(TauriStreamableHTTPClientTransport)
  })

  it('falls back to the Tauri transport when the URL is unchanged (direct upstream on Tauri)', () => {
    const transport = createMcpTransport(target, target)
    expect(transport).toBeInstanceOf(TauriStreamableHTTPClientTransport)
  })

  it('encodes the proxied URL as the transport endpoint, not the raw upstream URL', () => {
    const proxied = `http://localhost:8000/v1/proxy/${encodeURIComponent(target)}`
    const transport = createMcpTransport(target, proxied) as unknown as { _url: URL }
    // The SDK stores the URL as `_url` and uses it on every fetch call. Asserting on the
    // private property is the cleanest way to confirm the transport was wired with the
    // proxy URL — without spinning up a real server.
    expect(transport._url.toString()).toBe(proxied)
  })

  it('keeps the raw upstream URL on the Tauri transport when proxy is bypassed', () => {
    const transport = createMcpTransport(target, target) as unknown as { _url: URL }
    expect(transport._url.toString()).toBe(target)
  })
})
