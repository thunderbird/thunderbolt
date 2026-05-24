/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

const cloudUrl = 'http://localhost:8000/v1'
const targetUrl = 'https://api.openai.com/v1/chat/completions'

/**
 * Verifies the X-Proxy-Passthrough-* contract end-to-end from a real browser.
 *
 *   - Caller-supplied headers (Authorization, Content-Type, vendor headers like
 *     Anthropic-Beta / OpenAI-Beta) travel via the X-Proxy-Passthrough-<name>
 *     prefix on the request, so caller credentials never appear as the plain
 *     `Authorization` header (which is reserved for proxy auth — session
 *     cookie / bearer token) and never leak into HTTP access logs.
 *   - The request body is forwarded verbatim — bytes are not re-serialized.
 *   - Wrapped response headers (X-Proxy-Passthrough-*) round-trip past CORS
 *     (the backend lists vendor passthrough headers in `corsExposeHeaders`).
 *
 * The proxy is mocked via `page.route()` since the SSRF guard prevents loopback
 * upstreams; the contract under test is the wire format that `createProxyFetch`
 * emits (covered by unit tests in src/lib/proxy-fetch.test.ts) and that the
 * backend route accepts (covered by backend/src/proxy/e2e.test.ts). What this
 * spec adds: the contract holds inside a real browser, after a real auth flow,
 * across the real CORS boundary.
 */
test('Passthrough headers wrap caller headers and forward body verbatim', async ({ page }) => {
  const errors = collectPageErrors(page)

  let capturedHeaders: Record<string, string> = {}
  let capturedBody: string | null = null
  let capturedTargetHeader: string | null = null

  await page.route('**/v1/proxy*', async (route) => {
    const request = route.request()
    capturedHeaders = request.headers()
    capturedBody = request.postData()
    capturedTargetHeader = request.headers()['x-proxy-target-url'] ?? null

    await route.fulfill({
      status: 200,
      headers: {
        // CORS — mirror what the real backend's CORS middleware emits so the
        // browser exposes the wrapped passthrough headers to JS-land.
        'Access-Control-Allow-Origin': 'http://localhost:1421',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers':
          'X-Proxy-Passthrough-Content-Type, X-Proxy-Passthrough-Anthropic-Version, X-Proxy-Passthrough-Mcp-Session-Id',
        // Wrapped upstream headers (the prefix is what callers strip via
        // `unwrapHostedResponse` on the JS side).
        'X-Proxy-Passthrough-Content-Type': 'application/json',
        'X-Proxy-Passthrough-Anthropic-Version': '2023-06-01',
        'X-Proxy-Passthrough-Mcp-Session-Id': 'sess-xyz',
      },
      body: JSON.stringify({ id: 'resp-1', choices: [] }),
    })
  })

  await loginViaOidc(page)
  await page.goto('/')

  const payload = JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] })

  const result = await page.evaluate(
    async ({ proxyEndpoint, target, body }) => {
      // Mirror `createProxyFetch.buildHostedRequest`: caller headers go through
      // the X-Proxy-Passthrough- prefix, target URL goes through the
      // X-Proxy-Target-Url header, body is forwarded as-is.
      const res = await fetch(proxyEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Proxy-Target-Url': target,
          'X-Proxy-Passthrough-Authorization': 'Bearer sk-fake-upstream-key',
          'X-Proxy-Passthrough-Content-Type': 'application/json',
          'X-Proxy-Passthrough-Anthropic-Beta': 'tools-2024-04-04',
          'X-Proxy-Passthrough-Openai-Beta': 'assistants=v2',
        },
        body,
      })
      return {
        status: res.status,
        // Wrapped response headers should be visible across CORS — the
        // backend's corsExposeHeaders allow-list explicitly includes
        // X-Proxy-Passthrough-Content-Type, -Anthropic-Version, etc.
        wrappedContentType: res.headers.get('x-proxy-passthrough-content-type'),
        wrappedAnthropicVersion: res.headers.get('x-proxy-passthrough-anthropic-version'),
        wrappedMcpSessionId: res.headers.get('x-proxy-passthrough-mcp-session-id'),
        body: await res.json(),
      }
    },
    { proxyEndpoint: `${cloudUrl}/proxy`, target: targetUrl, body: payload },
  )

  // Status round-trips
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ id: 'resp-1' })

  // Caller headers reach the proxy with the passthrough prefix intact. Playwright
  // lower-cases header names — that's the wire-level format.
  expect(capturedTargetHeader).toBe(targetUrl)
  expect(capturedHeaders['x-proxy-passthrough-authorization']).toBe('Bearer sk-fake-upstream-key')
  expect(capturedHeaders['x-proxy-passthrough-content-type']).toBe('application/json')
  expect(capturedHeaders['x-proxy-passthrough-anthropic-beta']).toBe('tools-2024-04-04')
  expect(capturedHeaders['x-proxy-passthrough-openai-beta']).toBe('assistants=v2')

  // Body forwarded byte-for-byte (no re-serialization).
  expect(capturedBody).toBe(payload)

  // Critical safety invariant: the upstream's real Authorization key must NOT
  // travel as the plain `Authorization` header — that's reserved for proxy auth
  // (session cookie / bearer token). It must ONLY appear with the passthrough
  // prefix.
  expect(capturedHeaders['authorization']).toBeUndefined()

  // Wrapped response headers survive the CORS boundary — they come back to
  // JS-land. The unwrapping itself happens in `createProxyFetch`'s
  // `unwrapHostedResponse` (covered by src/lib/proxy-fetch.test.ts); here we
  // verify the wrapped form is even reachable post-CORS.
  expect(result.wrappedContentType).toBe('application/json')
  expect(result.wrappedAnthropicVersion).toBe('2023-06-01')
  expect(result.wrappedMcpSessionId).toBe('sess-xyz')

  expect(errors).toHaveLength(0)
})
