/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'

import type { SearchExaClient, SearchResponseDto } from '@/api/search'
import { authHeaders, createTestApp, type TestAppHandle } from '@/test-utils/e2e'

/** Build a stub Exa client whose `search` returns the canned results below.
 *  Passed to createTestApp via dep injection — replaces `mock.module('exa-js')`,
 *  which would leak across files (see docs/development/testing.md). */
const createStubExaClient = (
  results: object[] = [
    {
      id: '1',
      title: 'Public site',
      url: 'https://example.com/post',
      image: 'http://example.com/cover.png',
      favicon: 'https://example.com/favicon.ico',
      text: 'x'.repeat(1200),
      publishedDate: '2026-09-01',
    },
    { id: '2', title: null, url: 'http://example.org/another', image: null, favicon: null },
  ],
): SearchExaClient => {
  const search = mock(async (_q: string, _opts: unknown) => ({
    results,
  }))
  return { search: search as unknown as SearchExaClient['search'] }
}

describe('GET /v1/search — e2e', () => {
  let handle: TestAppHandle

  afterEach(async () => {
    if (handle) {
      await handle.cleanup()
    }
  })

  it('returns normalised results with HTTPS-only URLs', async () => {
    handle = await createTestApp({ searchExaClient: createStubExaClient() })
    const res = await handle.app.handle(
      new Request('http://localhost/v1/search?q=hello&limit=5', {
        method: 'GET',
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as SearchResponseDto
    expect(body.results[0].snippet).toBe('x'.repeat(1000))
    expect(body.results[0].publishedDate).toBe('2026-09-01')
    expect(body.results[1].snippet).toBe('')
    expect(body.results[1].publishedDate).toBeNull()
    expect(body.results).toHaveLength(2)
    // pageUrl always HTTPS — the http://example.org URL is upgraded.
    for (const r of body.results) {
      expect(r.pageUrl.startsWith('https://')).toBe(true)
    }
    // First result keeps title; image is upgraded from http://.
    expect(body.results[0].title).toBe('Public site')
    expect(body.results[0].previewImageUrl).toBe('https://example.com/cover.png')
    expect(body.results[0].faviconUrl).toBe('https://example.com/favicon.ico')
    // Second result: title falls back to hostname; favicon is derived from origin.
    expect(body.results[1].title).toBe('example.org')
    expect(body.results[1].faviconUrl).toBe('https://example.org/favicon.ico')
    expect(body.results[1].previewImageUrl).toBeNull()
  })

  it('returns empty search results without a second SDK request', async () => {
    const client = createStubExaClient([])
    handle = await createTestApp({ searchExaClient: client })
    const res = await handle.app.handle(
      new Request('http://localhost/v1/search?q=empty', { headers: authHeaders(handle.bearerToken) }),
    )
    expect(await res.json()).toEqual({ results: [] })
    expect(client.search).toHaveBeenCalledTimes(1)
  })

  it('returns 401 for unauthenticated requests', async () => {
    handle = await createTestApp({ searchExaClient: createStubExaClient() })
    const res = await handle.app.handle(new Request('http://localhost/v1/search?q=hello', { method: 'GET' }))
    expect(res.status).toBe(401)
  })
})
