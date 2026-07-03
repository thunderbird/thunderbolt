/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createProvider, setProviderCredentials, updateSettings } from '@/dal'
import { getDb } from '@/db/database'
import type { HttpClient } from '@/lib/http'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from '@/dal/test-utils'
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as api from './api'
import type { SearchResultData } from './schemas'
import { runWebSearch } from './web-search'

const dummyHttpClient = {} as unknown as HttpClient

/** A fetch stub returning a single JSON or text response. */
const stubFetch = (body: { json?: unknown; text?: string; contentType?: string }) => {
  const calls: string[] = []
  const fn = (async (url: string | URL) => {
    calls.push(url.toString())
    return new Response(body.text ?? (body.json !== undefined ? JSON.stringify(body.json) : ''), {
      status: 200,
      headers: { 'content-type': body.contentType ?? 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

describe('runWebSearch', () => {
  it('falls back to the backend Exa system default when no search provider is set', async () => {
    const backendResults: SearchResultData[] = [
      { title: 'Exa Result', pageUrl: 'https://exa.example/x', faviconUrl: null, previewImageUrl: null },
    ]
    const searchSpy = spyOn(api, 'search').mockResolvedValue(backendResults)
    const { fn, calls } = stubFetch({ json: {} })

    const results = await runWebSearch(
      { db: getDb(), workspaceId: wsId, httpClient: dummyHttpClient, fetchFn: fn },
      'hello',
    )

    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(calls()).toHaveLength(0) // provider fetch never used
    expect(results).toEqual([
      { title: 'Exa Result', url: 'https://exa.example/x', snippet: '', favicon: null, image: null },
    ])
    searchSpy.mockRestore()
  })

  it('routes to the configured JSON provider (exa) instead of the backend', async () => {
    const db = getDb()
    await createProvider(db, wsId, {
      id: 'prov-exa',
      type: 'exa',
      enabledCapabilities: ['search'],
      userId: testUserId,
    })
    await setProviderCredentials(db, 'prov-exa', { apiKey: 'exa-key' })
    await updateSettings(db, { search_provider_id: 'prov-exa' })

    const searchSpy = spyOn(api, 'search')
    const { fn, calls } = stubFetch({
      json: { results: [{ title: 'Provider Hit', url: 'https://p.example/1', text: 'From provider.' }] },
    })

    const results = await runWebSearch({ db, workspaceId: wsId, httpClient: dummyHttpClient, fetchFn: fn }, 'q')

    expect(searchSpy).not.toHaveBeenCalled()
    expect(calls()[0]).toContain('api.exa.ai/search')
    expect(results[0]).toMatchObject({ title: 'Provider Hit', url: 'https://p.example/1', snippet: 'From provider.' })
    searchSpy.mockRestore()
  })

  it('routes to keyless DuckDuckGo scraping when that provider is selected', async () => {
    const db = getDb()
    await createProvider(db, wsId, {
      id: 'prov-ddg',
      type: 'duckduckgo',
      enabledCapabilities: ['search'],
      userId: testUserId,
    })
    await updateSettings(db, { search_provider_id: 'prov-ddg' })

    const searchSpy = spyOn(api, 'search')
    const { fn, calls } = stubFetch({
      text: '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Fa">DDG Hit</a>',
      contentType: 'text/html',
    })

    const results = await runWebSearch({ db, workspaceId: wsId, httpClient: dummyHttpClient, fetchFn: fn }, 'q')

    expect(searchSpy).not.toHaveBeenCalled()
    expect(calls()[0]).toContain('html.duckduckgo.com')
    expect(results[0]).toMatchObject({ title: 'DDG Hit', url: 'https://ddg.example/a' })
    searchSpy.mockRestore()
  })

  it('falls back to the backend when search_provider_id points at a missing provider', async () => {
    const db = getDb()
    await updateSettings(db, { search_provider_id: 'does-not-exist' })
    const searchSpy = spyOn(api, 'search').mockResolvedValue([])
    const { fn } = stubFetch({ json: {} })

    await runWebSearch({ db, workspaceId: wsId, httpClient: dummyHttpClient, fetchFn: fn }, 'q')

    expect(searchSpy).toHaveBeenCalledTimes(1)
    searchSpy.mockRestore()
  })
})
