/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'

const mockDnsLookup = mock((host: string) => {
  if (host === 'private.test') return Promise.resolve([{ address: '192.168.1.1', family: 4 }])
  return Promise.resolve([{ address: '1.2.3.4', family: 4 }])
})
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))

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
    if (handle) await handle.cleanup()
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
      new Request(`http://localhost/v1/preview?url=${encodeURIComponent('https://preview.test/article')}`, {
        method: 'GET',
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(200)
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
      new Request(`http://localhost/v1/preview?url=${encodeURIComponent('https://preview.test/empty')}`, {
        method: 'GET',
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, string | null>
    expect(data.title).toBeNull()
    expect(data.summary).toBeNull()
    expect(data.previewImageUrl).toBeNull()
    expect(data.siteName).toBeNull()
  })

  it('rejects targets that resolve to a private address with 400', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview?url=${encodeURIComponent('https://127.0.0.1/secret')}`, {
        method: 'GET',
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 401 for unauthenticated requests', async () => {
    handle = await createTestApp({})
    const res = await handle.app.handle(
      new Request(`http://localhost/v1/preview?url=${encodeURIComponent('https://preview.test/x')}`, { method: 'GET' }),
    )
    expect(res.status).toBe(401)
  })
})
