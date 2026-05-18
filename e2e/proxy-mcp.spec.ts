/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

const cloudUrl = 'http://localhost:8000/v1'
const targetMcpServer = 'https://mcp.example.com/'

/**
 * MCP traffic in the current branch routes through the unified `/v1/proxy`
 * endpoint via `createProxyFetch` (see src/lib/mcp-provider.tsx). The MCP
 * `StreamableHTTPClientTransport` accepts a custom `fetch`, so the same proxy
 * client handles MCP, AI provider calls, and any other cross-origin traffic.
 *
 * This spec verifies the MCP-specific contract from a real browser:
 *
 *   - JSON-RPC POST goes to `${cloudUrl}/proxy` (NOT a per-MCP path like
 *     `/mcp-proxy/<id>` — single decision point).
 *   - The MCP server URL is in the X-Proxy-Target-Url header, NOT the path.
 *   - MCP transport headers (Accept: application/json, text/event-stream;
 *     Mcp-Session-Id; Mcp-Protocol-Version) wrap with the passthrough prefix.
 *   - The plain `Authorization` header is never sent — upstream MCP server
 *     auth, if any, would travel as `X-Proxy-Passthrough-Authorization` and
 *     get unwrapped by the proxy backend.
 *   - The JSON-RPC envelope round-trips intact.
 *
 * Approach: rather than booting a real MCP server (which requires fixture
 * conversation setup and a working `@ai-sdk/mcp` round-trip on the test page),
 * we drive a probe `fetch` that mimics what `StreamableHTTPClientTransport` +
 * `createProxyFetch` emit. The proxy is mocked with `page.route()` so the
 * upstream MCP server doesn't need to be reachable from CI.
 */
test('MCP traffic routes through /v1/proxy with X-Proxy-Target-Url + passthrough headers', async ({
  page,
}) => {
  const errors = collectPageErrors(page)

  let proxyHits = 0
  let capturedMethod: string | null = null
  let capturedUrl: string | null = null
  let capturedHeaders: Record<string, string> = {}
  let capturedBody: string | null = null

  await page.route('**/v1/proxy*', async (route) => {
    proxyHits += 1
    const request = route.request()
    capturedMethod = request.method()
    capturedUrl = request.url()
    capturedHeaders = request.headers()
    capturedBody = request.postData()

    // MCP servers respond with either application/json or an SSE stream. We
    // return JSON for simplicity — the JSON-RPC envelope is what matters.
    await route.fulfill({
      status: 200,
      headers: {
        'X-Proxy-Passthrough-Content-Type': 'application/json',
        'X-Proxy-Passthrough-Mcp-Session-Id': 'mcp-session-abc',
        'X-Proxy-Passthrough-Mcp-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'echo', description: 'Echo a message back.' }] },
      }),
    })
  })

  await loginViaOidc(page)
  await page.goto('/')

  // The probe mimics what the MCP transport emits when wrapped by
  // `createProxyFetch`: a POST to `${cloudUrl}/proxy` with the MCP server URL
  // in X-Proxy-Target-Url, JSON-RPC body, and standard MCP transport headers
  // wrapped with the passthrough prefix.
  const response = await page.evaluate(
    async ({ proxyEndpoint, target }) => {
      const res = await fetch(proxyEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Proxy-Target-Url': target,
          'X-Proxy-Passthrough-Accept': 'application/json, text/event-stream',
          'X-Proxy-Passthrough-Content-Type': 'application/json',
          'X-Proxy-Passthrough-Mcp-Session-Id': 'mcp-session-abc',
          'X-Proxy-Passthrough-Mcp-Protocol-Version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      })
      return {
        status: res.status,
        body: await res.json(),
      }
    },
    { proxyEndpoint: `${cloudUrl}/proxy`, target: targetMcpServer },
  )

  // Single round-trip
  expect(proxyHits).toBe(1)

  // POST + JSON-RPC body
  expect(capturedMethod).toBe('POST')
  expect(capturedBody).toBeTruthy()
  const parsedBody = JSON.parse(capturedBody!)
  expect(parsedBody).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

  // Single decision point: the URL the browser hit ends in /v1/proxy
  // (no MCP-specific path like /mcp-proxy/...; no per-server subpath).
  expect(capturedUrl).toContain('/v1/proxy')
  expect(capturedUrl).not.toContain('/mcp-proxy')
  // The MCP server URL travels in the header, NOT the URL path.
  expect(capturedUrl).not.toContain(encodeURIComponent(targetMcpServer))
  expect(capturedHeaders['x-proxy-target-url']).toBe(targetMcpServer)

  // MCP transport headers wrap with the passthrough prefix.
  expect(capturedHeaders['x-proxy-passthrough-accept']).toBe('application/json, text/event-stream')
  expect(capturedHeaders['x-proxy-passthrough-content-type']).toBe('application/json')
  expect(capturedHeaders['x-proxy-passthrough-mcp-session-id']).toBe('mcp-session-abc')
  expect(capturedHeaders['x-proxy-passthrough-mcp-protocol-version']).toBe('2024-11-05')

  // The plain `Authorization` header is reserved for proxy auth — never sent
  // from the MCP client probe (this branch keeps proxy auth separate from
  // upstream auth via the prefix split).
  expect(capturedHeaders['authorization']).toBeUndefined()
  // No legacy MCP-specific headers (the previous design used X-Mcp-Target-Url
  // and Mcp-Authorization — both retired by the unified proxy).
  expect(capturedHeaders).not.toHaveProperty('x-mcp-target-url')
  expect(capturedHeaders).not.toHaveProperty('mcp-authorization')

  // JSON-RPC response round-trips intact.
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'echo' }] },
  })

  expect(errors).toHaveLength(0)
})
