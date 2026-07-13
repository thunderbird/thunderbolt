/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { fetch as baseFetch } from '@/lib/fetch'
import type { MCPClient, NamedMCPClient } from '@/lib/mcp-provider'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import type { Tool } from 'ai'
import { mergeMcpTools, resolveOpenAiCompatConnection, sanitizeToolPrefix } from './fetch'

/** Mirror the `MCPClientError` the SDK throws after a transport drop. The
 *  runtime instance `name` is `'MCPClientError'` (the `AI_MCPClientError`
 *  constant is only the marker symbol). */
const closedError = (message = 'Connection closed') => Object.assign(new Error(message), { name: 'MCPClientError' })

/** A `Tool` is opaque to `mergeMcpTools` (it only spreads the map), so a tagged
 *  sentinel is enough to assert which client's tools landed in the result. */
const tool = (tag: string): Tool => ({ tag }) as unknown as Tool

/** Minimal fake satisfying the slice of `MCPClient` that `mergeMcpTools` uses,
 *  paired with the server identity. `name` becomes the tool prefix; `name`/`url`
 *  ride through to the `mcpTools` metadata map. Derived from `name` so tests can
 *  assert the tool→server resolution without extra plumbing. No SDK mocking. */
const named = (name: string, tools: () => Promise<Record<string, Tool>>): NamedMCPClient => ({
  id: `id-${name}`,
  name,
  url: `https://${name}.example.com`,
  client: { tools, close: () => {} } as unknown as MCPClient,
})

describe('sanitizeToolPrefix', () => {
  const cases: Array<[string | null | undefined, string]> = [
    ['Render', 'render'],
    ['render.com', 'render_com'],
    ['My Server', 'my_server'],
    ['api.github.com', 'api_github_com'],
    ['  spaced  ', 'spaced'],
    ['UPPER_snake', 'upper_snake'],
    ['weird!!!name', 'weird_name'],
    ['---', 'mcp'],
    ['', 'mcp'],
    [null, 'mcp'],
    [undefined, 'mcp'],
    ['localhost-3000', 'localhost_3000'],
  ]

  it.each(cases)('sanitizes %p → %p', (input, expected) => {
    expect(sanitizeToolPrefix(input)).toBe(expected)
  })
})

describe('mergeMcpTools', () => {
  it('prefixes each tool with its sanitized server name', async () => {
    const render = named('render', async () => ({ list_services: tool('ls'), get_service: tool('gs') }))

    const { toolset, summary } = await mergeMcpTools({}, [render], async () => null)

    expect(Object.keys(toolset).sort()).toEqual(['render_get_service', 'render_list_services'])
    expect(toolset.render_list_services).toEqual(tool('ls'))
    expect(summary).toBe('- render (2 tools)')
  })

  it('merges tools from every client — no reconnect on the happy path', async () => {
    const a = named('alpha', async () => ({ one: tool('a') }))
    const b = named('beta', async () => ({ two: tool('b') }))
    const reconnect = mock(async () => null)

    const { toolset } = await mergeMcpTools({}, [a, b], reconnect)

    expect(Object.keys(toolset).sort()).toEqual(['alpha_one', 'beta_two'])
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('disambiguates two servers whose names sanitize to the same prefix (render vs render_2)', async () => {
    const first = named('Render', async () => ({ deploy: tool('first') }))
    const second = named('render', async () => ({ deploy: tool('second') }))

    const { toolset, summary } = await mergeMcpTools({}, [first, second], async () => null)

    // Same base prefix → first keeps `render`, second becomes `render_2`; both
    // `deploy` tools survive because the prefixes differ.
    expect(toolset.render_deploy).toEqual(tool('first'))
    expect(toolset.render_2_deploy).toEqual(tool('second'))
    expect(Object.keys(toolset).sort()).toEqual(['render_2_deploy', 'render_deploy'])
    expect(summary).toBe('- render (1 tool)\n- render_2 (1 tool)')
  })

  it('reserves generated prefixes so a server that sanitizes to one is bumped again (no collision)', async () => {
    const first = named('render', async () => ({ deploy: tool('first') }))
    const second = named('render', async () => ({ deploy: tool('second') }))
    // Sanitizes to base `render_2` — the prefix generated for `second`.
    const third = named('render 2', async () => ({ deploy: tool('third') }))

    const { toolset } = await mergeMcpTools({}, [first, second, third], async () => null)

    // first → render, second → render_2, third → render_2_2; all distinct.
    expect(toolset.render_deploy).toEqual(tool('first'))
    expect(toolset.render_2_deploy).toEqual(tool('second'))
    expect(toolset.render_2_2_deploy).toEqual(tool('third'))
    // No server's tool dropped to a prefix collision — every deploy survives.
    expect(Object.keys(toolset).sort()).toEqual(['render_2_2_deploy', 'render_2_deploy', 'render_deploy'])
  })

  it('skips a prefixed tool that collides with a pre-seeded built-in and keeps the built-in', async () => {
    const builtIn = tool('built-in')
    const toolset = { render_search: builtIn }
    const render = named('render', async () => ({ search: tool('from-mcp'), list: tool('l') }))

    const { toolset: merged, summary } = await mergeMcpTools(toolset, [render], async () => null)

    // Same object mutated in place and returned; the built-in wins the collision.
    expect(merged).toBe(toolset)
    expect(merged.render_search).toBe(builtIn)
    expect(Object.keys(merged).sort()).toEqual(['render_list', 'render_search'])
    // Only the one tool that actually merged is counted.
    expect(summary).toBe('- render (1 tool)')
  })

  it('reconnects once and retries when tools() throws a closed-connection error', async () => {
    let calls = 0
    const dropped = named('render', async () => {
      calls++
      throw closedError()
    })
    const fresh = { tools: async () => ({ alpha: tool('fresh') }), close: () => {} } as unknown as MCPClient
    const reconnect = mock(async () => fresh)

    const { toolset } = await mergeMcpTools({}, [dropped], reconnect)

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(reconnect).toHaveBeenCalledWith(dropped.client)
    expect(calls).toBe(1)
    expect(toolset.render_alpha).toEqual(tool('fresh'))
  })

  it('skips the dropped server but still merges the others when reconnect fails (non-blocking)', async () => {
    const dropped = named('render', async () => {
      throw closedError('Attempted to send a request from a closed client')
    })
    const healthy = named('github', async () => ({ beta: tool('b') }))
    const reconnect = mock(async () => null)

    const { toolset, summary } = await mergeMcpTools({}, [dropped, healthy], reconnect)

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(Object.keys(toolset)).toEqual(['github_beta'])
    // The dropped server contributes nothing to the summary.
    expect(summary).toBe('- github (1 tool)')
  })

  it('skips the server when the fresh client also fails after reconnect', async () => {
    const dropped = named('render', async () => {
      throw closedError()
    })
    const stillBroken = {
      tools: async () => {
        throw closedError()
      },
      close: () => {},
    } as unknown as MCPClient
    const healthy = named('github', async () => ({ beta: tool('b') }))
    const reconnect = mock(async () => stillBroken)

    const { toolset } = await mergeMcpTools({}, [dropped, healthy], reconnect)

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(Object.keys(toolset)).toEqual(['github_beta'])
  })

  it('does not reconnect and propagates non-closed errors', async () => {
    const boom = new Error('boom — capability missing')
    const broken = named('render', async () => {
      throw boom
    })
    const reconnect = mock(async () => null)

    await expect(mergeMcpTools({}, [broken], reconnect)).rejects.toThrow('boom — capability missing')
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('returns an undefined summary when no MCP tools were added', async () => {
    const empty = named('render', async () => ({}))

    const { summary } = await mergeMcpTools({}, [empty], async () => null)

    expect(summary).toBeUndefined()
  })

  describe('mcpTools metadata map', () => {
    it('maps each namespaced tool name to its owning server and bare tool name', async () => {
      const render = named('render', async () => ({ list_services: tool('ls') }))

      const { mcpTools } = await mergeMcpTools({}, [render], async () => null)

      expect(mcpTools).toEqual({
        render_list_services: { name: 'render', url: 'https://render.example.com', toolName: 'list_services' },
      })
    })

    it('keys tools from disambiguated prefixes (render / render_2) to the right server', async () => {
      const first = named('Render', async () => ({ deploy: tool('first') }))
      const second = named('render', async () => ({ deploy: tool('second') }))

      const { mcpTools } = await mergeMcpTools({}, [first, second], async () => null)

      // Each namespaced tool name resolves back to the server that produced it —
      // `render_deploy` → first, `render_2_deploy` → second — with no ambiguity.
      expect(mcpTools).toEqual({
        render_deploy: { name: 'Render', url: 'https://Render.example.com', toolName: 'deploy' },
        render_2_deploy: { name: 'render', url: 'https://render.example.com', toolName: 'deploy' },
      })
    })

    it('omits servers that contributed no tools', async () => {
      const empty = named('render', async () => ({}))
      const healthy = named('github', async () => ({ search: tool('s') }))

      const { mcpTools } = await mergeMcpTools({}, [empty, healthy], async () => null)

      expect(mcpTools).toEqual({
        github_search: { name: 'github', url: 'https://github.example.com', toolName: 'search' },
      })
    })

    it('does not record a tool skipped due to a collision with a pre-seeded built-in', async () => {
      const toolset = { render_search: tool('built-in') }
      const render = named('render', async () => ({ search: tool('from-mcp'), list: tool('l') }))

      const { mcpTools } = await mergeMcpTools(toolset, [render], async () => null)

      // The colliding `search` is skipped, so only the tool that actually merged is recorded.
      expect(mcpTools).toEqual({
        render_list: { name: 'render', url: 'https://render.example.com', toolName: 'list' },
      })
    })

    it('is undefined when no MCP tools were added', async () => {
      const empty = named('render', async () => ({}))

      const { mcpTools } = await mergeMcpTools({}, [empty], async () => null)

      expect(mcpTools).toBeUndefined()
    })
  })
})

/** Minimal Custom-provider Model fixture. Only `provider`, `url`, and `apiKey`
 *  are read by `resolveOpenAiCompatConnection` for the custom case, so the
 *  other fields don't need to be realistic. */
const customModel = (url: string | null, apiKey: string | null = 'k'): Model =>
  ({ provider: 'custom', url, apiKey }) as unknown as Model

/** Distinguishable proxy-fetch stub so tests can assert transport dispatch by
 *  identity comparison: loopback URLs must NOT return this — they get baseFetch. */
const stubProxyFetch: FetchFn = Object.assign(
  (async () => new Response()) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  { preconnect: () => Promise.resolve(false) },
)

describe('resolveOpenAiCompatConnection (custom)', () => {
  it('returns null when no URL is configured', () => {
    expect(resolveOpenAiCompatConnection(customModel(null), () => stubProxyFetch)).toBeNull()
  })

  it('normalises the baseURL — appends /v1 when missing', () => {
    const conn = resolveOpenAiCompatConnection(customModel('http://localhost:1234'), () => stubProxyFetch)
    expect(conn?.baseURL).toBe('http://localhost:1234/v1')
  })

  it('keeps an already-normalised baseURL (with /v1)', () => {
    const conn = resolveOpenAiCompatConnection(customModel('http://localhost:1234/v1'), () => stubProxyFetch)
    expect(conn?.baseURL).toBe('http://localhost:1234/v1')
  })

  it.each(['http://localhost:1234', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234', 'http://api.localhost'])(
    'dispatches loopback URL %s directly through baseFetch (bypasses the proxy)',
    (url) => {
      const conn = resolveOpenAiCompatConnection(customModel(url), () => stubProxyFetch)
      expect(conn?.fetch).toBe(baseFetch)
    },
  )

  it.each([
    'https://api.some-vendor.com/v1',
    'http://192.168.1.42:1234', // RFC1918 — intentionally not loopback
    'http://host.docker.internal:1234',
    'http://mymac.local:1234',
    'http://10.evil.com/v1', // attacker-crafted hostname that starts with a private range
  ])('dispatches non-loopback URL %s through the proxy fetch', (url) => {
    const conn = resolveOpenAiCompatConnection(customModel(url), () => stubProxyFetch)
    expect(conn?.fetch).toBe(stubProxyFetch)
  })

  it('forwards the apiKey as-is (empty string when missing)', () => {
    expect(
      resolveOpenAiCompatConnection(customModel('http://localhost:1234', null), () => stubProxyFetch)?.apiKey,
    ).toBe('')
    expect(
      resolveOpenAiCompatConnection(customModel('http://localhost:1234', 'sk-abc'), () => stubProxyFetch)?.apiKey,
    ).toBe('sk-abc')
  })
})
