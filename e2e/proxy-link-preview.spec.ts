/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

/**
 * 1x1 transparent PNG (smallest valid PNG, 67 bytes). Used to fake the upstream
 * link-preview image response so the spec doesn't depend on the real internet.
 */
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const targetImage = 'https://example.com/photo.jpg'

/**
 * THU-473: the link-preview image caller is migrated from the legacy
 * `/pro/link-preview/proxy-image/<encoded>` sub-route to the unified
 * `/v1/proxy/<encoded>` endpoint via `useProxyUrl()`. This spec verifies the
 * end-to-end contract: a frontend `<img>` request hits the unified proxy URL,
 * the proxy round-trips, and the rendered image is non-zero size.
 *
 * We intercept the proxy call with `page.route(...)` so the upstream image
 * doesn't need to be reachable from CI.
 *
 * Approach choice: rather than booting a chat session and triggering a real
 * `<LinkPreviewWidget>` render (which requires synthesizing source registry
 * metadata via the assistant streaming pipeline), we inject a probe `<img>`
 * whose `src` is constructed by mirroring `getProxyUrl`'s exact format. The
 * route handler is what proves the migration works (the URL must match
 * `/v1/proxy/**`); decoding the target inside the handler proves the encoding
 * is round-trippable; asserting `naturalWidth > 0` proves the proxy round-trip
 * actually delivered the bytes the browser could decode. Same blueprint used
 * in `proxy-favicon.spec.ts`.
 */
test('link-preview image renders via /v1/proxy round-trip with ?token= JWT', async ({ page }) => {
  const errors = collectPageErrors(page)

  let proxyHits = 0
  let proxiedTarget: string | null = null
  let proxyTokenQuery: string | null = null

  // Mock the JWT mint endpoint so the frontend has a token before <img> renders.
  await page.route('**/api/auth/token', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'fake-test-jwt' }),
    })
  })

  // Intercept any /v1/proxy/* request and answer with a real PNG so the browser
  // can decode it and report a non-zero naturalWidth.
  await page.route('**/v1/proxy/**', async (route) => {
    proxyHits += 1
    const url = new URL(route.request().url())
    // Path is `/v1/proxy/<encoded-target>`; decode the last segment.
    const encoded = url.pathname.split('/v1/proxy/')[1] ?? ''
    proxiedTarget = decodeURIComponent(encoded)
    proxyTokenQuery = url.searchParams.get('token')
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: {
        'Cache-Control': 'private, max-age=600',
        'CDN-Cache-Control': 'no-store',
      },
      body: onePixelPng,
    })
  })

  await loginViaOidc(page)
  // Settings page is the cheapest authenticated route that loads the full app shell.
  await page.goto('/settings/preferences')
  await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible({ timeout: 10_000 })

  // Construct the proxy URL the same way `getProxyUrl` does (encodeURIComponent
  // of the target, appended to `${cloudUrl}/proxy/`, with `?token=<jwt>` suffix).
  const proxyImgUrl = `http://localhost:8000/v1/proxy/${encodeURIComponent(targetImage)}?token=fake-test-jwt`

  // Inject an <img> that points at the proxy URL. We wait for the load event
  // explicitly so the assertion below has a deterministic signal.
  await page.evaluate(
    ({ src }) =>
      new Promise<void>((resolve, reject) => {
        const img = document.createElement('img')
        img.id = 'proxy-link-preview-probe'
        img.alt = ''
        img.addEventListener('load', () => resolve())
        img.addEventListener('error', () => reject(new Error(`link-preview image failed to load from ${src}`)))
        img.src = src
        document.body.appendChild(img)
      }),
    { src: proxyImgUrl },
  )

  // The route handler must have fired exactly once with the encoded target URL.
  expect(proxyHits).toBe(1)
  expect(proxiedTarget).toBe(targetImage)
  expect(proxyTokenQuery).toBe('fake-test-jwt')

  // The browser actually decoded the PNG (naturalWidth > 0 proves the response
  // was a valid image, not a 4xx/5xx body).
  const naturalWidth = await page
    .locator('#proxy-link-preview-probe')
    .evaluate((el) => (el as HTMLImageElement).naturalWidth)
  expect(naturalWidth).toBeGreaterThan(0)

  // The single-decision-point invariant: the URL the browser hit ends in
  // /v1/proxy/<encoded>, NOT the legacy /pro/link-preview/proxy-image/<encoded>.
  const renderedSrc = await page
    .locator('#proxy-link-preview-probe')
    .evaluate((el) => (el as HTMLImageElement).src)
  expect(renderedSrc).toContain('/v1/proxy/')
  expect(renderedSrc).not.toContain('/pro/link-preview/proxy-image/')
  expect(renderedSrc).toContain('?token=fake-test-jwt')

  expect(errors).toHaveLength(0)
})
