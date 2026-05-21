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
})
