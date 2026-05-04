/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

const targetMcpServer = 'https://mcp.example.com/'

/**
 * THU-474: the MCP client now routes JSON-RPC traffic through the unified
 * `/v1/proxy/<encodedFullUrl>` endpoint via `useProxyUrl()`, dropping the
 * pre-existing `X-Mcp-Target-Url` / `/mcp-proxy/<subpath>` patterns. Upstream
 * auth (when needed) travels as `X-Upstream-Authorization`; the proxy renames
 * it to `Authorization` before forwarding. Plain `Authorization` is reserved
 * for proxy auth (session cookie) and is never sent from this client.
 *
 * Approach: rather than booting a real MCP server and threading a tool call
 * through the assistant pipeline (which would require a fixture conversation
 * and a working `@ai-sdk/mcp` round-trip on the test page), we inject a probe
 * `fetch` from `page.evaluate` that mimics what the MCP client would send —
 * POST to the proxy URL, JSON-RPC body, `X-Upstream-Authorization` header. We
 * intercept the proxy POST with `page.route(...)` and assert the request shape
 * matches the migrated contract:
 *
 *   - URL is `/v1/proxy/<encoded-mcp-server-url>`
 *   - Method is POST
 *   - `X-Upstream-Authorization` is forwarded (proxy will rename it to
 *     `Authorization` before reaching upstream)
 *   - No legacy headers (`X-Mcp-Target-Url`, `Mcp-Authorization`) and no plain
 *     `Authorization` header (which is reserved for proxy auth)
 *   - Body is a valid JSON-RPC envelope
 *
 * The route handler returns a controlled JSON-RPC response so the probe can
 * assert it round-trips intact. Same blueprint used in `proxy-favicon.spec.ts`
 * and `proxy-link-preview.spec.ts` — the wiring is what's under test, not a
 * real upstream MCP server.
 */
test('MCP traffic routes through /v1/proxy with X-Upstream-Authorization', async ({ page }) => {
  const errors = collectPageErrors(page)

  let proxyHits = 0
  let proxiedTarget: string | null = null
  let capturedMethod: string | null = null
  let capturedHeaders: Record<string, string> = {}
  let capturedBody: string | null = null

  // Mock the JWT mint endpoint — even though MCP uses Bearer auth (cookies)
  // and doesn't strictly need ?token=, useProxyUrl appends it uniformly so
  // the proxy treats every caller through the same auth path.
  await page.route('**/api/auth/token', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'fake-test-jwt' }),
    })
  })

  // Intercept the proxy POST and answer with a JSON-RPC envelope so the probe
  // can verify the response round-trips intact.
  await page.route('**/v1/proxy/**', async (route) => {
    proxyHits += 1
    const request = route.request()
    capturedMethod = request.method()
    capturedHeaders = request.headers()
    capturedBody = request.postData()

    const url = new URL(request.url())
    // Path is `/v1/proxy/<encoded-target>`; decode the last segment.
    const encoded = url.pathname.split('/v1/proxy/')[1] ?? ''
    proxiedTarget = decodeURIComponent(encoded)

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'echo', description: 'Echo a message back.' }] },
      }),
    })
  })

  await loginViaOidc(page)
  // Settings page is the cheapest authenticated route that loads the full app shell.
  await page.goto('/settings/preferences')
  await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible({ timeout: 10_000 })

  // Mirror `getProxyUrl`'s exact format: `${cloudUrl}/proxy/${encodeURIComponent(target)}?token=<jwt>`.
  // The default cloud_url in the test environment is http://localhost:8000/v1.
  const proxyTargetUrl = `http://localhost:8000/v1/proxy/${encodeURIComponent(targetMcpServer)}?token=fake-test-jwt`

  // Probe `fetch` that mimics what `StreamableHTTPClientTransport` POSTs:
  //   - POST + JSON-RPC body
  //   - `Accept: application/json, text/event-stream` (set by the SDK)
  //   - `Content-Type: application/json` (set by the SDK)
  //   - `X-Upstream-Authorization` for upstream auth (the migrated convention)
  // We assert the response was a valid JSON-RPC envelope to prove round-trip.
  const response = await page.evaluate(async ({ url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-Upstream-Authorization': 'Bearer upstream-token-xyz',
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
  }, { url: proxyTargetUrl })

  // Route fired exactly once with the encoded MCP server URL decoded back out.
  expect(proxyHits).toBe(1)
  expect(proxiedTarget).toBe(targetMcpServer)

  // POST + JSON-RPC body.
  expect(capturedMethod).toBe('POST')
  expect(capturedBody).toBeTruthy()
  const parsedBody = JSON.parse(capturedBody!)
  expect(parsedBody).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

  // Migrated headers: `X-Upstream-Authorization` is forwarded; the proxy will
  // rename it before sending upstream. Header keys from Playwright are
  // lower-cased, hence the `.toLowerCase()` lookups.
  expect(capturedHeaders['x-upstream-authorization']).toBe('Bearer upstream-token-xyz')

  // Single-decision-point invariants: legacy MCP-specific headers must NOT be
  // present, and the plain `Authorization` header must NEVER be sent from the
  // MCP client (it is reserved for proxy auth — session cookie today).
  expect(capturedHeaders).not.toHaveProperty('x-mcp-target-url')
  expect(capturedHeaders).not.toHaveProperty('mcp-authorization')
  expect(capturedHeaders).not.toHaveProperty('authorization')

  // Round-trip: the JSON-RPC response body reached the caller intact.
  expect(response.status).toBe(200)
  expect(response.body).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'echo' }] },
  })

  expect(errors).toHaveLength(0)
})
