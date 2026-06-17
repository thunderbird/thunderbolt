/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'

import {
  authHeaders,
  createTestApp,
  createTestUpstream,
  createUpstreamRouter,
  type TestAppHandle,
} from '@/test-utils/e2e'

const buildHtml = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`

describe('GET /v1/preview — e2e', () => {
  let handle: TestAppHandle

  afterEach(async () => {
    if (handle) {
      await handle.cleanup()
    }
  })

  it('returns OG metadata with HTTPS-upgraded image, title, summary, siteName', async () => {
    const upstream = createTestUpstream(
      'preview.test',
      () =>
        new Response(
          buildHtml(`
          <meta property="og:title" content="Hello &amp; world" />
          <meta property="og:description" content="A &quot;short&quot; summary" />
          <meta property="og:image" content="http://preview.test/cover.png" />
          <meta property="og:site_name" content="Preview Test" />
        `),
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    )
    handle = await createTestApp({ fetchFn: createUpstreamRouter({ 'preview.test': upstream }) })

    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://preview.test/article' }),
      }),
    )
    expect(res.status).toBe(200)
    // Italo's review: per-user 10 min cache; no shared/CDN cache (`private`).
    expect(res.headers.get('cache-control')).toBe('private, max-age=600')
    const data = (await res.json()) as Record<string, string | null>
    expect(data.title).toBe('Hello & world')
    expect(data.summary).toBe('A "short" summary')
    expect(data.siteName).toBe('Preview Test')
    // http:// in og:image is auto-upgraded.
    expect(data.previewImageUrl).toBe('https://preview.test/cover.png')
  })

  it('returns all-null when the page has no OG tags', async () => {
    const upstream = createTestUpstream(
      'preview.test',
      () =>
        new Response(buildHtml('<title>plain</title>'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    handle = await createTestApp({ fetchFn: createUpstreamRouter({ 'preview.test': upstream }) })

    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://preview.test/empty' }),
      }),
    )
    expect(res.status).toBe(200)
    // Successful extraction with no OG tags is a legitimate result — cache it.
    expect(res.headers.get('cache-control')).toBe('private, max-age=600')
    const data = (await res.json()) as Record<string, string | null>
    expect(data.title).toBeNull()
    expect(data.summary).toBeNull()
    expect(data.previewImageUrl).toBeNull()
    expect(data.siteName).toBeNull()
  })

  it('does not cache the empty-fallback when upstream returns a non-OK status', async () => {
    const upstream = createTestUpstream('preview.test', () => new Response('bad gateway', { status: 502 }))
    handle = await createTestApp({ fetchFn: createUpstreamRouter({ 'preview.test': upstream }) })

    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://preview.test/down' }),
      }),
    )
    expect(res.status).toBe(200)
    // Transient upstream failures must not stick in the per-user cache for 10 minutes.
    expect(res.headers.get('cache-control')).not.toBe('private, max-age=600')
    const data = (await res.json()) as Record<string, string | null>
    expect(data.title).toBeNull()
  })

  it('rejects targets that resolve to a private address with 400', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://127.0.0.1/secret' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 401 for unauthenticated requests', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://preview.test/x' }),
      }),
    )
    expect(res.status).toBe(401)
  })

  // --- SSRF advisory regression (thunderbolt_SSRF.md) ---
  // The advisory claims a path-style `GET /link-preview/[target_url]` endpoint
  // with no validation. That route does not exist, and the real `POST /v1/preview`
  // blocks every claimed vector. These tests pin that down at the endpoint level.

  it('does not expose the advisory path-style /link-preview endpoint (404)', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request('http://localhost/link-preview/http%3A%2F%2F127.0.0.1%3A8000%2Fv1%2Fhealth', {
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(404)
  })

  it('rejects the advisory PoC loopback target with 400', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1:8000/v1/health' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects a decimal-encoded loopback target (http://2130706433/) with 400', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://2130706433/' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('blocks a hostname that resolves to a private address (DNS rebinding) without leaking', async () => {
    // The default e2e resolver maps `private.test` → 192.168.1.1, so the
    // hostname passes the literal pre-check but is blocked at DNS-pin time.
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview`, {
        method: 'POST',
        headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://private.test/latest/meta-data/' }),
      }),
    )
    // Blocked safe-fetch surfaces as the empty fallback, never cached.
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).not.toBe('private, max-age=600')
    const data = (await res.json()) as Record<string, string | null>
    expect(data.title).toBeNull()
    expect(data.previewImageUrl).toBeNull()
  })
})
