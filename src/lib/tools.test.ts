/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type getTinfoilSearchAvailability, getTinfoilSearchConnection } from '@/integrations/tinfoil-search/connection'
import { getDb } from '@/db/database'
import { saveIntegrationCredentials } from '@/dal/integrations'
import { createModel } from '@/dal/models'
import { updateSettings } from '@/dal'
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { clearCachedSession } from '@/lib/session-cache'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createRecordingClient } from '@/test-utils/http-client'
import { createTinfoilWebApi } from '@/integrations/tinfoil-search/api'
import type { SourceMetadata } from '@/types/source'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, test } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import type { ToolCallOptions } from 'ai'
import { z } from 'zod'
import type { HttpClient } from '@/contexts'
import type { ToolConfig } from '@/types'
import { createWebToolBudget, webToolCaps } from '@/ai/web-tool-budget'
import { createTool, createToolset, getAvailableTools, type ToolAvailabilityContext, type ToolCallCache } from './tools'

const connectedTinfoil = async () => ({ tinfoil: true, tinfoilConfigured: true })
const unconfiguredTinfoil = async () => ({ tinfoil: false, tinfoilConfigured: false })

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

// These run WITHOUT a test database set up. The injected context must fully
// drive availability, so any reintroduced `getSettings`/`getIntegrationStatus`
// read (the duplicate the DI removed) would surface here. This locks in the
// dedup from the hot send path (`aiFetchStreamingResponse`).
describe('getAvailableTools (injected context)', () => {
  beforeEach(() => {
    clearCachedSession()
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
    setAuthToken('session')
  })
  afterEach(() => {
    useSearchProviderStore.getState().clearSearchProvider()
    clearAuthToken()
  })

  it('does not expose backend tools for a selected server without a session', async () => {
    clearAuthToken()
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({
        settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true },
        integrationStatus: integrationStatus({ googleEnabled: true, microsoftEnabled: true }),
      }),
    )
    expect(tools.map(({ name }) => name)).toEqual(['render_html'])
  })

  it('does not expose server web tools without a configured server', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    setAuthToken('stale-session')
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({
        settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true },
        integrationStatus: integrationStatus({ googleEnabled: true, microsoftEnabled: true }),
      }),
    )
    expect(tools.map(({ name }) => name)).toEqual(['render_html'])
  })

  it('exposes own-key web tools without a server or Pro integration', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    useSearchProviderStore.getState().configureSearchProvider('brave-key')
    const tools = await getAvailableTools(stubHttpClient, undefined, context())
    expect(tools.map(({ name }) => name)).toEqual(['render_html', 'search'])
  })

  it('exposes Tinfoil search through regular Pi tools and the source collector without a separate key', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const api = createTinfoilWebApi(
      async () => 'token',
      async () => ({
        structuredContent: { results: [{ title: 'Evidence', url: 'https://example.com', content: 'A fact' }] },
      }),
    )
    const sources: SourceMetadata[] = []
    const tools = await getAvailableTools(stubHttpClient, sources, context({ tinfoilSearchApi: api }), connectedTinfoil)
    expect(tools.map(({ name }) => name)).toEqual(['render_html', 'search', 'fetch_content'])
    const piTools = await toPiAgentTools(createToolset(tools))
    const search = piTools.find((tool) => tool.name === 'search')!
    const result = await search.execute('search-call', { query: 'test', max_results: 1 })
    expect(JSON.stringify(result.content)).toContain('Source 1')
    expect(sources).toMatchObject([{ url: 'https://example.com', index: 1, toolName: 'search' }])
  })

  it('returns only the always-available render_html tool when every gate is disabled', async () => {
    const tools = await getAvailableTools(stubHttpClient, undefined, context())
    expect(tools.map((tool) => tool.name)).toEqual(['render_html'])
  })

  it('includes task tools when experimentalFeatureTasks is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ settings: { experimentalFeatureTasks: true, integrationsProIsEnabled: false } }),
    )
    expect(tools.length).toBeGreaterThan(0)
  })

  it('includes Google tools only when the Google integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ integrationStatus: integrationStatus({ googleEnabled: true }) }),
    )
    expect(tools.some((tool) => tool.name.startsWith('google'))).toBe(true)
  })

  it('includes Microsoft tools only when the Microsoft integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ integrationStatus: integrationStatus({ microsoftEnabled: true }) }),
    )
    expect(tools.some((tool) => tool.name.startsWith('microsoft'))).toBe(true)
  })

  it('does not expose cloud tools when automatic Tinfoil search becomes unavailable', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
    const availability = context({
      settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true },
      tinfoilConfigured: true,
    })
    const tools = await getAvailableTools(stubHttpClient, undefined, availability)
    expect(tools.map(({ name }) => name)).toEqual(['render_html'])
    useSearchProviderStore.getState().selectSearchProvider('cloud')
    const cloudTools = await getAvailableTools(stubHttpClient, undefined, availability)
    expect(cloudTools.some(({ name }) => name === 'search')).toBe(true)
  })

  it('includes Pro tools when the Pro integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true } }),
    )
    expect(tools.some((tool) => tool.name === 'search')).toBe(true)
  })
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

describe('search provider changes during an active turn', () => {
  afterEach(() => useSearchProviderStore.getState().clearSearchProvider())

  it.each(['none', 'custom', 'cloud'] as const)(
    'stops Tinfoil calls when search selection changes to %s',
    async (selection) => {
      useSearchProviderStore.getState().selectSearchProvider('tinfoil')
      let calls = 0
      const api = createTinfoilWebApi(
        async () => 'token',
        async () => {
          calls++
          return { structuredContent: { results: [] } }
        },
      )
      const tools = await getAvailableTools(
        stubHttpClient,
        undefined,
        context({ tinfoilSearchApi: api }),
        connectedTinfoil,
      )
      const search = tools.find(({ name }) => name === 'search')!
      useSearchProviderStore.getState().selectSearchProvider(selection)
      await expect(search.execute({ query: 'test', max_results: 1 })).rejects.toThrow('Search provider changed')
      expect(calls).toBe(0)
    },
  )

  it('does not retain a replaced or disconnected custom search credential', async () => {
    useSearchProviderStore.getState().configureSearchProvider('old-key', 'exa')
    const tools = await getAvailableTools(stubHttpClient, undefined, context(), unconfiguredTinfoil)
    const search = tools.find(({ name }) => name === 'search')!
    useSearchProviderStore.getState().configureSearchProvider('new-key', 'exa')
    await expect(search.execute({ query: 'test', max_results: 1 })).rejects.toThrow('Search provider changed')
    useSearchProviderStore.getState().disconnectSearchProvider()
    await expect(search.execute({ query: 'test', max_results: 1 })).rejects.toThrow('Search provider changed')
  })
})

describe('live search availability during a turn', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await resetTestDatabase()
    await updateSettings(getDb(), { integrations_pro_is_enabled: true })
    clearCachedSession()
    useSearchProviderStore.getState().clearSearchProvider()
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: false })
    setAuthToken('session')
  })
  afterEach(() => {
    useSearchProviderStore.getState().clearSearchProvider()
    clearAuthToken()
  })

  const cloudSettings = { experimentalFeatureTasks: false, integrationsProIsEnabled: true }
  const cloudResponse = JSON.stringify({
    results: [{ title: 'Cloud evidence', pageUrl: 'https://cloud-source.example/' }],
  })
  const tinfoilResponse = {
    structuredContent: {
      results: [{ title: 'Private evidence', url: 'https://private-source.example/', content: 'A fact' }],
    },
  }

  it.each(['oauth', 'byok', 'disabled', 'disconnected', 'reauth'] as const)(
    'stops an existing automatic Cloud tool after Tinfoil is configured (%s)',
    async (state) => {
      const { client, requests } = createRecordingClient(() => cloudResponse)
      const sources: SourceMetadata[] = []
      const tools = await getAvailableTools(
        client,
        sources,
        context({ settings: cloudSettings, ...(await getTinfoilSearchConnection(getDb())) }),
      )
      const search = tools.find(({ name }) => name === 'search')!
      await search.execute({ query: 'before connection' })
      const previousSources = [...sources]
      if (state === 'byok') {
        await createModel(getDb(), {
          id: 'byok',
          name: 'Tinfoil',
          provider: 'tinfoil',
          model: 'test',
          apiKey: 'own-key',
          enabled: 1,
        })
      } else {
        await saveIntegrationCredentials(
          getDb(),
          'tinfoil',
          { access_token: state === 'disconnected' ? '' : 'token', reauth_required: state === 'reauth' },
          state !== 'disabled' && state !== 'disconnected',
        )
      }
      await expect(search.execute({ query: 'private follow-up' })).rejects.toThrow('Search provider changed')
      await expect(
        tools.find(({ name }) => name === 'fetch_content')!.execute({ url: 'https://example.com/private' }),
      ).rejects.toThrow('Search provider changed')
      expect(requests).toEqual(['search'])
      expect(sources).toEqual(previousSources)
    },
  )

  it.each(['disabled', 'disconnected', 'reauth'] as const)(
    'stops an existing Tinfoil tool after its connection becomes %s without falling back to Cloud',
    async (state) => {
      await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'token' }, true)
      const call = mock(async () => tinfoilResponse)
      const createApi = mock(() => createTinfoilWebApi(async () => 'token', call))
      const { client, requests } = createRecordingClient(() => cloudResponse)
      const sources: SourceMetadata[] = []
      const tools = await getAvailableTools(
        client,
        sources,
        context({ settings: cloudSettings, ...(await getTinfoilSearchConnection(getDb(), createApi)) }),
      )
      const search = tools.find(({ name }) => name === 'search')!
      await search.execute({ query: 'before disconnect' })
      await saveIntegrationCredentials(
        getDb(),
        'tinfoil',
        { access_token: state === 'disconnected' ? '' : 'token', reauth_required: state === 'reauth' },
        state === 'reauth',
      )
      await expect(search.execute({ query: 'after disconnect' })).rejects.toThrow('Search provider changed')
      expect(call).toHaveBeenCalledTimes(1)
      expect(createApi).toHaveBeenCalledTimes(1)
      expect(requests).toEqual([])
      expect(sources).toMatchObject([{ index: 1, allowRemoteImages: false }])
    },
  )

  it.each(['auto', 'tinfoil'] as const)(
    'keeps the same %s Tinfoil API and source registry when availability is unchanged',
    async (selection) => {
      useSearchProviderStore.getState().selectSearchProvider(selection)
      await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'token' }, true)
      const call = mock(async () => tinfoilResponse)
      const createApi = mock(() => createTinfoilWebApi(async () => 'token', call))
      const sources: SourceMetadata[] = []
      const tools = await getAvailableTools(
        stubHttpClient,
        sources,
        context(await getTinfoilSearchConnection(getDb(), createApi)),
      )
      const search = tools.find(({ name }) => name === 'search')!
      await search.execute({ query: 'first' })
      await search.execute({ query: 'second' })
      expect(call).toHaveBeenCalledTimes(2)
      expect(createApi).toHaveBeenCalledTimes(1)
      expect(sources).toMatchObject([{ index: 1, allowRemoteImages: false }])
      expect(sources).toHaveLength(1)
    },
  )

  it('stops Cloud search and page reads after disabling the integration', async () => {
    await updateSettings(getDb(), { integrations_pro_is_enabled: true })
    const { client, requests } = createRecordingClient(() => cloudResponse)
    const tools = await getAvailableTools(client, [], context({ settings: cloudSettings }))
    await tools.find(({ name }) => name === 'search')!.execute({ query: 'before disable' })
    await updateSettings(getDb(), { integrations_pro_is_enabled: false })
    for (const name of ['search', 'fetch_content']) {
      await expect(
        tools.find((tool) => tool.name === name)!.execute({ query: 'after disable', url: 'https://example.com' }),
      ).rejects.toThrow('Search provider changed')
    }
    expect(requests).toEqual(['search'])
  })

  it('stops Cloud calls after sign-out even in managed mode', async () => {
    const { client, requests } = createRecordingClient(() => cloudResponse)
    const tools = await getAvailableTools(client, [], context({ settings: cloudSettings }))
    clearAuthToken()
    await expect(tools.find(({ name }) => name === 'search')!.execute({ query: 'after sign-out' })).rejects.toThrow(
      'Search provider changed',
    )
    expect(requests).toEqual([])
  })

  it('keeps automatic Cloud search available when no provider changed', async () => {
    const { client, requests } = createRecordingClient(() => cloudResponse)
    const tools = await getAvailableTools(client, [], context({ settings: cloudSettings }))
    const search = tools.find(({ name }) => name === 'search')!
    await search.execute({ query: 'first' })
    await search.execute({ query: 'second' })
    expect(requests).toEqual(['search', 'search'])
  })

  it('preserves an explicit Cloud choice when Tinfoil connects mid-turn', async () => {
    useSearchProviderStore.getState().selectSearchProvider('cloud')
    const { client, requests } = createRecordingClient(() => cloudResponse)
    const tools = await getAvailableTools(client, [], context({ settings: cloudSettings }))
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'token' }, true)
    await tools.find(({ name }) => name === 'search')!.execute({ query: 'explicit cloud' })
    expect(requests).toEqual(['search'])
  })

  it('reads the latest selection after awaiting connection availability', async () => {
    const current = Promise.withResolvers<Awaited<ReturnType<typeof getTinfoilSearchAvailability>>>()
    const { client, requests } = createRecordingClient(() => cloudResponse)
    const tools = await getAvailableTools(client, [], context({ settings: cloudSettings }), () => current.promise)
    const failure = tools
      .find(({ name }) => name === 'search')!
      .execute({ query: 'pending' })
      .catch((error: unknown) => error)
    useSearchProviderStore.getState().selectSearchProvider('none')
    current.resolve({ tinfoil: false, tinfoilConfigured: false })
    expect(await failure).toMatchObject({ message: expect.stringContaining('Search provider changed') })
    expect(requests).toEqual([])
  })

  it('does not dispatch using a stale snapshot when the availability read fails', async () => {
    const { client, requests } = createRecordingClient(() => cloudResponse)
    const tools = await getAvailableTools(client, [], context({ settings: cloudSettings }), async () => {
      throw new Error('Database unavailable')
    })
    await expect(tools.find(({ name }) => name === 'search')!.execute({ query: 'pending' })).rejects.toThrow(
      'Database unavailable',
    )
    expect(requests).toEqual([])
  })
})
