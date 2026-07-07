/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, test } from 'bun:test'
import type { ToolCallOptions } from 'ai'
import { z } from 'zod'
import type { HttpClient } from '@/contexts'
import type { ToolConfig } from '@/types'
import { createTool, createToolset, getAvailableTools, type ToolAvailabilityContext, type ToolCallCache } from './tools'

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

  it('includes Pro tools when the Pro integration is enabled', async () => {
    const tools = await getAvailableTools(
      stubHttpClient,
      undefined,
      context({ settings: { experimentalFeatureTasks: false, integrationsProIsEnabled: true } }),
    )
    expect(tools.some((tool) => tool.name === 'search')).toBe(true)
  })
})
