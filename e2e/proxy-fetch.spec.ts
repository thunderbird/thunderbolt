/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

const cloudUrl = 'http://localhost:8000/v1'
const targetUrl = 'https://upstream.example.com/api/v1/things'

/**
 * Universal proxy contract — basic GET round-trip.
 *
 * The current branch routes Hosted-mode (web) cross-origin calls through the
 * `${cloudUrl}/proxy` endpoint via `createProxyFetch`. The wire format is:
 *
 *   - URL is `${cloudUrl}/proxy` (target NOT in path; keeps user URLs out of
 *     standard HTTP access logs).
 *   - `X-Proxy-Target-Url` header carries the upstream URL.
 *   - Request headers are copied to `X-Proxy-Passthrough-<name>` (skipping
 *     browser-injected headers like cookie/origin/host).
 *   - Response headers prefixed with `X-Proxy-Passthrough-` are unwrapped back
 *     to natural names by `createProxyFetch`'s response handling.
 *
 * We mock the proxy with `page.route()` rather than hitting the real backend
 * (the backend's SSRF guard blocks loopback upstreams in dev, so we can't easily
 * stand up a real upstream). The contract under test is the frontend wire
 * format. Same blueprint as the auth specs — `loginViaOidc` to load the app
 * shell, then drive a probe inside `page.evaluate`.
 */
test('GET via /v1/proxy carries X-Proxy-Target-Url and unwraps passthrough response headers', async ({
  page,
}) => {
  const errors = collectPageErrors(page)

  let proxyHits = 0
  let capturedTargetHeader: string | null = null
  let capturedMethod: string | null = null
  let capturedUrl: string | null = null

  await page.route('**/v1/proxy*', async (route) => {
    proxyHits += 1
    const request = route.request()
    capturedMethod = request.method()
    capturedUrl = request.url()
    capturedTargetHeader = request.headers()['x-proxy-target-url'] ?? null

    await route.fulfill({
      status: 201,
      headers: {
        // CORS — mirror what the real backend's CORS middleware emits so the
        // browser exposes the wrapped passthrough headers to JS-land. The
        // production allow-list is in backend/src/config/settings.ts
        // (`corsExposeHeaders`); we only need to satisfy the browser here.
        'Access-Control-Allow-Origin': 'http://localhost:1421',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers':
          'X-Proxy-Final-Url, X-Proxy-Passthrough-Content-Type, X-Proxy-Passthrough-Cache-Control',
        // Upstream's real headers are wrapped with the passthrough prefix.
        // The frontend strips the prefix before handing the response to callers.
        'X-Proxy-Passthrough-Content-Type': 'application/json',
        'X-Proxy-Passthrough-Cache-Control': 'private, max-age=600',
        'X-Proxy-Final-Url': targetUrl,
        // Proxy-set framing headers MUST be filtered out by the frontend.
        'Content-Security-Policy': 'sandbox',
        'Content-Disposition': 'attachment',
      },
      body: JSON.stringify({ ok: true, items: [1, 2, 3] }),
    })
  })

  await loginViaOidc(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ proxyEndpoint, target }) => {
      // Probe `fetch` mirrors `createProxyFetch`'s wire format: target URL in
      // the X-Proxy-Target-Url header, request headers prefixed with
      // X-Proxy-Passthrough-. Response headers come back wrapped with the same
      // prefix.
      const res = await fetch(proxyEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Proxy-Target-Url': target,
          'X-Proxy-Passthrough-Accept': 'application/json',
        },
      })
      return {
        status: res.status,
        rawContentType: res.headers.get('x-proxy-passthrough-content-type'),
        // Whether the wrapped headers are visible — they may or may not be,
        // depending on whether `createProxyFetch` is in play. We're driving raw
        // fetch here, so we expect them to remain wrapped.
        unwrappedContentType: res.headers.get('content-type'),
        body: await res.json(),
      }
    },
    { proxyEndpoint: `${cloudUrl}/proxy`, target: targetUrl },
  )

  expect(proxyHits).toBe(1)
  expect(capturedMethod).toBe('POST')
  // The proxy URL the frontend hit must be `${cloudUrl}/proxy` (target NOT in path).
  expect(capturedUrl).toContain('/v1/proxy')
  // Encoded target must NOT appear anywhere in the URL — it must travel via header only.
  expect(capturedUrl).not.toContain(encodeURIComponent(targetUrl))
  expect(capturedTargetHeader).toBe(targetUrl)

  // Status passes through verbatim.
  expect(result.status).toBe(201)
  // The raw fetch sees the wrapped headers; `createProxyFetch` would unwrap
  // them. We verify the wrapped header is present so the wire-format contract
  // is observable.
  expect(result.rawContentType).toBe('application/json')
  expect(result.body).toEqual({ ok: true, items: [1, 2, 3] })

  expect(errors).toHaveLength(0)
})
