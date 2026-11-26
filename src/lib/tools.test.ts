/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { saveProviderConnection, disconnectProviderConnection } from '@/dal/provider-connections'
import { updateSettings } from '@/dal'
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { clearCachedSession } from '@/lib/session-cache'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createRecordingClient } from '@/test-utils/http-client'
import { createTinfoilWebApi } from '@/integrations/tinfoil-search/api'
import { createOtariWebApi } from '@/integrations/otari-search/api'
import { stubJsonResponse } from '@/test-utils/http'
import type { SourceMetadata } from '@/types/source'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn, test } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import type { ToolCallOptions } from 'ai'
import { z } from 'zod'
import type { HttpClient } from '@/contexts'
import type { ToolConfig } from '@/types'
import { createWebToolBudget, webToolCaps } from '@/ai/web-tool-budget'
import {
  createTool,
  createToolset,
  getAvailableTools,
  loadConnectedSearchApis,
  type ToolAvailabilityContext,
  type ToolCallCache,
} from './tools'

const options: ToolCallOptions = { toolCallId: 't1', messages: [] }

/** Build a cacheable ToolConfig whose executor records every call it receives. */
const makeConfig = (overrides: Partial<ToolConfig> = {}): { config: ToolConfig; calls: unknown[] } => {
  const calls: unknown[] = []
  const config: ToolConfig = {
    name: 'fake',
    description: 'fake',
    verb: 'faking',
    parameters: z.object({ q: z.string().optional(), a: z.number().optional(), b: z.number().optional() }),
    execute: async (params: unknown) => {
      calls.push(params)
      return { echoed: params }
    },
    cacheable: true,
    ...overrides,
  }
  return { config, calls }
}

describe('createTool dedupe', () => {
  test('reuses the result for identical input within one cache', async () => {
    const cache: ToolCallCache = new Map()
    const { config, calls } = makeConfig()
    const t = createTool(config, cache)
    const first = await t.execute!({ q: 'x' }, options)
    const second = await t.execute!({ q: 'x' }, options)
    expect(calls).toHaveLength(1)
    expect(second).toEqual(first)
  })

  test('keys ignore object key order', async () => {
    const cache: ToolCallCache = new Map()
    const { config, calls } = makeConfig()
    const t = createTool(config, cache)
    await t.execute!({ a: 1, b: 2 }, options)
    await t.execute!({ b: 2, a: 1 }, options)
    expect(calls).toHaveLength(1)
  })

  test('different input executes again', async () => {
    const cache: ToolCallCache = new Map()
    const { config, calls } = makeConfig()
    const t = createTool(config, cache)
    await t.execute!({ q: 'x' }, options)
    await t.execute!({ q: 'y' }, options)
    expect(calls).toHaveLength(2)
  })

  test('does not cache a failed execution — the next call re-runs', async () => {
    const cache: ToolCallCache = new Map()
    let attempts = 0
    const { config } = makeConfig({
      execute: async () => {
        attempts++
        if (attempts === 1) {
          throw new Error('boom')
        }
        return { ok: true }
      },
    })
    const t = createTool(config, cache)
    await expect(t.execute!({ q: 'x' }, options)).rejects.toThrow('boom')
    const recovered = await t.execute!({ q: 'x' }, options)
    expect(attempts).toBe(2)
    expect(recovered).toEqual({ ok: true })
  })

  test('non-cacheable tools always execute', async () => {
    const cache: ToolCallCache = new Map()
    const { config, calls } = makeConfig({ cacheable: false })
    const t = createTool(config, cache)
    await t.execute!({ q: 'x' }, options)
    await t.execute!({ q: 'x' }, options)
    expect(calls).toHaveLength(2)
  })

  test('without a cache, identical calls always execute', async () => {
    const { config, calls } = makeConfig()
    const t = createTool(config)
    await t.execute!({ q: 'x' }, options)
    await t.execute!({ q: 'x' }, options)
    expect(calls).toHaveLength(2)
  })

  test('in-flight identical calls share a single execution', async () => {
    const cache: ToolCallCache = new Map()
    let executions = 0
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { config } = makeConfig({
      execute: async () => {
        executions++
        await gate
        return { ok: true }
      },
    })
    const t = createTool(config, cache)
    // Both calls start before the first resolves, so the second must reuse the
    // first's in-flight promise rather than launching a second execution.
    const calls = Promise.all([t.execute!({ q: 'x' }, options), t.execute!({ q: 'x' }, options)])
    release({})
    await calls
    expect(executions).toBe(1)
  })
})

describe('createToolset dedupe', () => {
  test('shares one cache across tools but keys by tool name', async () => {
    const cache: ToolCallCache = new Map()
    const { config: alpha, calls: alphaCalls } = makeConfig({ name: 'alpha' })
    const { config: beta, calls: betaCalls } = makeConfig({ name: 'beta' })
    const set = createToolset([alpha, beta], cache)
    await set.alpha.execute!({ q: 'x' }, options)
    await set.alpha.execute!({ q: 'x' }, options)
    await set.beta.execute!({ q: 'x' }, options)
    expect(alphaCalls).toHaveLength(1)
    expect(betaCalls).toHaveLength(1)
  })
})

describe('createTool web budget', () => {
  test('web tools share one budget and normalized turn cache', async () => {
    const budget = createWebToolBudget('auto')
    const { config: search, calls: searchCalls } = makeConfig({ name: 'search' })
    const { config: fetchContent, calls: fetchCalls } = makeConfig({ name: 'fetch_content' })
    const set = createToolset([search, fetchContent], new Map(), budget)

    const first = await set.search.execute!({ query: ' Foo  Bar ' }, options)
    const duplicate = await set.search.execute!({ query: 'foo bar' }, options)
    await set.fetch_content.execute!({ url: 'https://example.com/' }, options)
    for (let call = 2; call < webToolCaps.auto; call++) {
      await set.search.execute!({ query: `query ${call}` }, options)
    }
    const exhausted = await set.search.execute!({ query: 'new query' }, options)

    expect(duplicate).toEqual(first)
    expect(searchCalls).toHaveLength(webToolCaps.auto - 1)
    expect(fetchCalls).toHaveLength(1)
    expect(exhausted).toMatchObject({ status: 'budget_exhausted' })
    expect(budget.probe.exhaustedAttempts).toBe(1)
  })

  test('evicts rejected executions from the turn cache', async () => {
    const budget = createWebToolBudget('search')
    let attempts = 0
    const { config } = makeConfig({
      name: 'search',
      execute: async () => {
        attempts++
        if (attempts === 1) {
          throw new Error('boom')
        }
        return { ok: true }
      },
    })
    const t = createTool(config, new Map(), budget)

    await expect(t.execute!({ query: 'same' }, options)).rejects.toThrow('boom')
    await expect(t.execute!({ query: 'same' }, options)).resolves.toEqual({ ok: true })
    expect(attempts).toBe(2)
  })

  test('passes unparseable URLs through to the tool error path', async () => {
    const budget = createWebToolBudget('auto')
    const { config, calls } = makeConfig({
      name: 'fetch_content',
      execute: async (params: unknown) => {
        calls.push(params)
        return { error: 'Invalid URL' }
      },
    })
    const t = createTool(config, new Map(), budget)

    await expect(t.execute!({ url: 'not a url' }, options)).resolves.toEqual({ error: 'Invalid URL' })
    expect(calls).toEqual([{ url: 'not a url' }])
  })

  test('non-web tools never consume the web budget', async () => {
    const budget = createWebToolBudget('auto')
    const { config, calls } = makeConfig({ name: 'calendar' })
    const t = createTool(config, new Map(), budget)

    await t.execute!({ q: 'x' }, options)
    await t.execute!({ q: 'y' }, options)
    await t.execute!({ q: 'z' }, options)

    expect(calls).toHaveLength(3)
    expect(budget.probe.isExhausted).toBe(false)
  })
})

// Tool config builders only capture the client inside their `execute` closures,
// so an empty stub is enough to exercise the availability branching.
const stubHttpClient = {} as HttpClient

const integrationStatus = (
  overrides: Partial<ToolAvailabilityContext['integrationStatus']> = {},
): ToolAvailabilityContext['integrationStatus'] => ({
  googleConnected: false,
  googleEnabled: false,
  googleEmail: null,
  microsoftConnected: false,
  microsoftEnabled: false,
  microsoftEmail: null,
  ...overrides,
})

const context = (overrides: Partial<ToolAvailabilityContext> = {}): ToolAvailabilityContext => ({
  settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: false },
  integrationStatus: integrationStatus(),
  ...overrides,
})

test('web results expose live remaining calls through the real Pi bridge without changing source IDs or cached data', async () => {
  const budget = createWebToolBudget('auto', true)
  const { config, calls } = makeConfig({
    name: 'search',
    execute: async (input) => {
      calls.push(input)
      return [{ sourceIndex: 7, sourceLabel: '[Source 7]', snippet: 'fact' }]
    },
  })
  const [web] = await toPiAgentTools(createToolset([config], undefined, budget))
  const first = await web.execute('one', { query: 'one' })
  expect(first.content).toContainEqual({
    type: 'text',
    text: `Web calls remaining this turn: ${webToolCaps.auto - 1}.`,
  })
  for (let call = 1; call < webToolCaps.auto - 1; call++) {
    await web.execute(`extra-${call}`, { query: `extra-${call}` })
  }
  const last = await web.execute('two', { query: 'two' })
  expect(last.content).toContainEqual({
    type: 'text',
    text: 'Web calls remaining this turn: 0. Synthesize now from the available evidence; do not call web tools again.',
  })
  expect(last.details).toEqual(first.details)
  const cached = await web.execute('cache', { query: 'one' })
  expect(cached.content).toEqual(last.content)
  expect(calls).toHaveLength(webToolCaps.auto)
  budget.promote('research')
  const promoted = await web.execute('promoted-cache', { query: 'one' })
  expect(promoted.content).toContainEqual({
    type: 'text',
    text: `Web calls remaining this turn: ${webToolCaps.research - webToolCaps.auto}.`,
  })
  expect(promoted.details).toEqual(first.details)
  expect(budget.consumed).toBe(webToolCaps.auto)
})

describe('selected connection discovery', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await updateSettings(getDb(), { experimental_feature_otari: true })
    await saveProviderConnection(getDb(), {
      id: 'otari',
      provider: 'otari',
      name: 'Otari',
      url: 'https://otari.example/api/v1',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    useSearchProviderStore.getState().configureProviderSearch('otari', 'available')
  })
  afterEach(async () => {
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
    await resetTestDatabase()
  })
  it.each(['none', 'cloud', 'auto'] as const)('does not contact an unselected gateway for %s', async (selection) => {
    const fetch = spyOn(globalThis, 'fetch')
    useSearchProviderStore.getState().selectSearchProvider(selection)
    expect(await loadConnectedSearchApis(getDb())).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })
  it('discovers the exact selected connection and retries cached unavailable capabilities', async () => {
    useSearchProviderStore.getState().configureProviderSearch('otari', 'unknown')
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ id: 'otari_web_search', direct_available: true }] }),
    )
    expect(await loadConnectedSearchApis(getDb())).toMatchObject({
      searchConnectionId: 'otari',
      searchApi: { search: expect.any(Function) },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves hidden Otari selection without credentials, discovery or Cloud fallback', async () => {
    await updateSettings(getDb(), { experimental_feature_otari: false })
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
    setAuthToken('session')
    try {
      const fetch = spyOn(globalThis, 'fetch')
      const available = await loadConnectedSearchApis(getDb())
      expect(available).toEqual({ searchConnectionId: 'otari', searchApi: undefined })
      const tools = await getAvailableTools(
        stubHttpClient,
        [],
        context({ ...available, settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true } }),
      )
      expect(tools.map(({ name }) => name)).toEqual(['render_html', 'run_office_script'])
      expect(fetch).not.toHaveBeenCalled()
      expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: 'otari' })
    } finally {
      clearAuthToken()
    }
  })
  it('does not discover Otari when another named connection is selected', async () => {
    await saveProviderConnection(getDb(), {
      id: 'exa',
      provider: 'exa',
      name: 'Exa',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    useSearchProviderStore.getState().selectSearchConnection('exa')
    const fetch = spyOn(globalThis, 'fetch')
    expect((await loadConnectedSearchApis(getDb())).searchConnectionId).toBe('exa')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not offer a disconnected connection or fall back to the server', async () => {
    await disconnectProviderConnection(getDb(), 'otari')
    const available = await loadConnectedSearchApis(getDb())
    const tools = await getAvailableTools(
      stubHttpClient,
      [],
      context({ ...available, settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true } }),
    )
    expect(tools.map(({ name }) => name)).toEqual(['render_html', 'run_office_script'])
  })
})

describe('getAvailableTools with injected availability', () => {
  beforeEach(() => {
    clearCachedSession()
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
    setAuthToken('session')
  })
  afterEach(() => {
    useSearchProviderStore.getState().clearSearchProvider()
    clearAuthToken()
  })
  it.each(['signed-out', 'no-server'] as const)(
    'keeps connected Google/Microsoft tools, but excludes cloud search with %s',
    async (state) => {
      if (state === 'signed-out') {
        clearAuthToken()
      } else {
        useLocalSettingsStore.setState({ cloudUrl: '' })
      }
      const tools = await getAvailableTools(
        stubHttpClient,
        undefined,
        context({
          settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true },
          integrationStatus: integrationStatus({ googleEnabled: true, microsoftEnabled: true }),
        }),
      )
      expect(tools.some(({ name }) => name.startsWith('google'))).toBe(true)
      expect(tools.some(({ name }) => name.startsWith('microsoft'))).toBe(true)
      expect(tools.some(({ name }) => name === 'search' || name === 'fetch_content')).toBe(false)
    },
  )
  it('includes only the app tools by default and task tools when enabled', async () => {
    expect((await getAvailableTools(stubHttpClient, undefined, context())).map(({ name }) => name)).toEqual([
      'render_html',
      'run_office_script',
    ])
    expect(
      (
        await getAvailableTools(
          stubHttpClient,
          undefined,
          context({ settings: { experimentalFeatureTasks: true, integrationsProIsEnabled: false } }),
        )
      ).length,
    ).toBeGreaterThan(1)
  })
  it.each(['googleEnabled', 'microsoftEnabled'] as const)('includes integration tools only when %s', async (flag) => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ integrationStatus: integrationStatus({ [flag]: true }) }),
    )
    expect(tools.some(({ name }) => name.startsWith(flag === 'googleEnabled' ? 'google' : 'microsoft'))).toBe(true)
  })
  it('exposes Tinfoil through Pi with the same private source collector and no extra key', async () => {
    useSearchProviderStore.getState().selectSearchConnection('private')
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const api = createTinfoilWebApi(
      async () => 'token',
      async () => ({
        structuredContent: { results: [{ title: 'Evidence', url: 'https://example.com', content: 'A fact' }] },
      }),
    )
    const sources: SourceMetadata[] = []
    const tools = await getAvailableTools(
      stubHttpClient,
      sources,
      context({ searchApi: api, searchConnectionId: 'private' }),
    )
    const search = (await toPiAgentTools(createToolset(tools))).find(({ name }) => name === 'search')!
    expect(JSON.stringify((await search.execute('call', { query: 'test' })).content)).toContain('Source 1')
    expect(sources).toMatchObject([{ url: 'https://example.com', index: 1, allowRemoteImages: false }])
  })
  it('exposes Otari search and page reading, stopping when another account is selected', async () => {
    useSearchProviderStore.getState().selectSearchConnection('work')
    const post = mock(() =>
      stubJsonResponse({ results: [{ title: 'Page', url: 'https://example.com', snippet: 'Summary' }] }),
    )
    const api = createOtariWebApi('https://otari.example/api/v1', async () => 'key', { ...stubHttpClient, post })
    const tools = await getAvailableTools(stubHttpClient, [], context({ searchConnectionId: 'work', searchApi: api }))
    expect(tools.some(({ name }) => name === 'fetch_content')).toBe(true)
    await tools.find(({ name }) => name === 'search')!.execute({ query: 'test' })
    useSearchProviderStore.getState().selectSearchConnection('personal')
    await expect(tools.find(({ name }) => name === 'search')!.execute({ query: 'private' })).rejects.toThrow(
      'Search provider changed',
    )
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('rejects stale construction context after the selection changes', async () => {
    const api = createTinfoilWebApi(
      async () => 'token',
      async () => ({ structuredContent: { results: [] } }),
    )
    useSearchProviderStore.getState().selectSearchConnection('new-account')
    expect(
      (await getAvailableTools(stubHttpClient, [], context({ searchConnectionId: 'old-account', searchApi: api }))).map(
        ({ name }) => name,
      ),
    ).toEqual(['render_html', 'run_office_script'])
  })
  it.each(['none', 'cloud', 'auto'] as const)(
    'stops an existing private tool after selecting %s',
    async (selection) => {
      useSearchProviderStore.getState().selectSearchConnection('private')
      const call = mock(async () => ({ structuredContent: { results: [] } }))
      const api = createTinfoilWebApi(async () => 'token', call)
      const tools = await getAvailableTools(
        stubHttpClient,
        [],
        context({ searchConnectionId: 'private', searchApi: api }),
      )
      useSearchProviderStore.getState().selectSearchProvider(selection)
      await expect(tools.find(({ name }) => name === 'search')!.execute({ query: 'private' })).rejects.toThrow(
        'Search provider changed',
      )
      expect(call).not.toHaveBeenCalled()
    },
  )
})

describe('live Cloud routing', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await updateSettings(getDb(), { integrations_pro_is_enabled: true })
    clearCachedSession()
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
    setAuthToken('session')
  })
  afterEach(async () => {
    mock.restore()
    clearAuthToken()
    useSearchProviderStore.getState().clearSearchProvider()
    await resetTestDatabase()
  })
  const settings = { experimentalFeatureTasks: false, integrationsProIsEnabled: true }
  const response = JSON.stringify({ results: [{ title: 'Cloud', pageUrl: 'https://example.com/' }] })
  it.each(['disable', 'sign-out', 'private', 'none'] as const)('stops Cloud calls after %s', async (change) => {
    const { client, requests } = createRecordingClient(() => response)
    const tools = await getAvailableTools(client, [], context({ settings }))
    const search = tools.find(({ name }) => name === 'search')!
    await search.execute({ query: 'before' })
    if (change === 'disable') {
      await updateSettings(getDb(), { integrations_pro_is_enabled: false })
    }
    if (change === 'sign-out') {
      clearAuthToken()
    }
    if (change === 'private') {
      useSearchProviderStore.getState().configureProviderSearch('private', 'available')
    }
    if (change === 'none') {
      useSearchProviderStore.getState().selectSearchProvider('none')
    }
    await expect(search.execute({ query: 'after' })).rejects.toThrow('Search provider changed')
    expect(requests).toEqual(['search'])
  })
  it('keeps explicit Cloud routing when another unused connection is saved', async () => {
    useSearchProviderStore.getState().selectSearchProvider('cloud')
    const { client, requests } = createRecordingClient(() => response)
    const tools = await getAvailableTools(client, [], context({ settings }))
    await saveProviderConnection(getDb(), {
      provider: 'tinfoil',
      name: 'Private',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    await tools.find(({ name }) => name === 'search')!.execute({ query: 'explicit cloud' })
    expect(requests).toEqual(['search'])
  })
})
