/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { assembleBuiltInModelInput, createPrompt } from '@/ai/prompt'
import { createTurnTelemetry } from '@/ai/turn-telemetry'
import { defaultSkillResearch, defaultSkillWeather } from '@/defaults/skills'
import { defaultModelGlm52 } from '@shared/defaults/models'
import { fetch as baseFetch } from '@/lib/fetch'
import { createAuthenticatedClient } from '@/lib/http'
import type { MCPClient, NamedMCPClient } from '@/lib/mcp-provider'
import { appVersionUnsupported, resetAppVersionBlockedForTesting } from '@/lib/app-version-unsupported'
import type { FetchFn } from '@/lib/proxy-fetch'
import { resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { selectEnabledSkillDefinitions } from '@/skills/skill-tool'
import type { Model, Skill } from '@/types'
import { getClock } from '@/testing-library'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { setupConsoleSpy, type ConsoleSpies } from '@/test-utils/console-spies'
import type { Tool } from 'ai'
import * as tinfoilClient from './tinfoil-client'
import {
  addSkillTool,
  buildVolatileSystemNotes,
  createModel,
  mergeMcpTools,
  resolveOpenAiCompatConnection,
  sanitizeToolPrefix,
  selectPromptSkillDefinitions,
  aiFetchStreamingResponse,
  withAppVersionHeader,
} from './fetch'

const usageSse = (...counts: Array<readonly [number, number, number]>): string =>
  `${counts
    .map(
      ([promptTokens, completionTokens, totalTokens]) =>
        `data: ${JSON.stringify({
          id: 'response-id',
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
          },
        })}`,
    )
    .join('\n\n')}\n\ndata: [DONE]\n\n`

const createTinfoilFetchClient = () => {
  const requestBodies: string[] = []
  const client = {
    getBaseURL: () => 'https://enclave.example.com/v1',
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(String(init?.body))
      return new Response(usageSse([4, 0, 4], [8, 1, 9], [12, 1, 13], [16, 2, 18]), {
        headers: {
          'Content-Type': 'text/event-stream',
          'x-inference-usage-receipt': 'iu1.payload.signature',
        },
      })
    },
  }
  return { client, requestBodies }
}

type CapturedOpenAiBody = {
  stream_options?: { include_usage?: boolean }
}

const completedSse = (receipt: string): Response =>
  new Response(
    `${[
      {
        id: 'response-id',
        choices: [{ delta: { content: 'Completed response' }, finish_reason: null }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      },
      {
        id: 'response-id',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 16, completion_tokens: 2, total_tokens: 18 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}`)
      .join('\n\n')}\n\ndata: [DONE]\n\n`,
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'x-inference-usage-receipt': receipt,
      },
    },
  )

const pumpClockUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt++) {
    await Promise.resolve()
    await getClock().runAllAsync()
    if (predicate()) {
      return
    }
  }
  throw new Error('Timed out while draining the AI response')
}

const pumpShortClockUntil = async (predicate: () => boolean): Promise<void> => {
  for (let elapsedMs = 0; elapsedMs < 250; elapsedMs++) {
    await getClock().tickAsync(1)
    if (predicate()) {
      return
    }
  }
  throw new Error('Timed out before the short test deadline')
}

const serializeConsoleCalls = ({ log, info, error, warn }: ConsoleSpies): string =>
  JSON.stringify([...log.mock.calls, ...info.mock.calls, ...error.mock.calls, ...warn.mock.calls])

/** Capturing fetch (same shape as `stubProxyFetch`): records the last
 *  (input, init) and returns an empty 200 so the wrapped fetch can be driven
 *  without a real network. */
const capturingFetch = () => {
  let received: { input: RequestInfo | URL; init?: RequestInit } | null = null
  const fn: FetchFn = Object.assign(
    ((input: RequestInfo | URL, init?: RequestInit) => {
      received = { input, init }
      return Promise.resolve(new Response())
    }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    { preconnect: () => Promise.resolve(false) },
  )
  return { fn, received: () => received }
}

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

describe('addSkillTool', () => {
  const skills = [
    {
      name: 'weather',
      description: 'Use for weather forecasts.',
      instruction: 'Emit the weather widget contract.',
    },
  ]

  it('registers the skill tool only for tool-capable models', () => {
    expect(Object.keys(addSkillTool({}, skills, true))).toEqual(['skill'])
    expect(addSkillTool({}, skills, false)).toEqual({})
  })
})

describe('selectPromptSkillDefinitions', () => {
  const storedSkills: Skill[] = [
    { ...defaultSkillWeather, instruction: 'WIDGET_CONTRACT_BODY' },
    { ...defaultSkillResearch, instruction: 'TASK_SKILL_BODY' },
    {
      ...defaultSkillResearch,
      id: 'user-authored-skill',
      name: 'user-authored',
      label: 'User Authored',
      instruction: 'USER_AUTHORED_SKILL_BODY',
    },
  ]

  /** Build a prompt with only skill capability varying between cases. */
  const createSkillPrompt = (supportsTools: boolean) =>
    createPrompt({
      modelName: 'Test Model',
      profile: null,
      preferredName: '',
      location: {},
      localization: {
        distanceUnit: 'imperial',
        temperatureUnit: 'f',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: '12h',
        currency: 'USD',
      },
      integrationStatus: 'READY',
      hasWebTools: false,
      skills: selectPromptSkillDefinitions(storedSkills, supportsTools),
      supportsTools,
    })

  it('inlines only widget rendering contracts for non-tool models', () => {
    const prompt = createSkillPrompt(false)

    expect(prompt).toContain('### weather\nWIDGET_CONTRACT_BODY')
    expect(prompt).not.toContain('TASK_SKILL_BODY')
    expect(prompt).not.toContain('USER_AUTHORED_SKILL_BODY')
    expect(prompt).not.toContain('- research:')
    expect(prompt).not.toContain('- user-authored:')
  })

  it('keeps the full skill listing for tool-capable models', () => {
    const prompt = createSkillPrompt(true)

    expect(prompt).toContain('Use the `skill` tool')
    expect(prompt).toContain('- weather:')
    expect(prompt).toContain('- research:')
    expect(prompt).toContain('- user-authored:')
    expect(prompt).not.toContain('WIDGET_CONTRACT_BODY')
    expect(prompt).not.toContain('TASK_SKILL_BODY')
    expect(prompt).not.toContain('USER_AUTHORED_SKILL_BODY')
  })

  it('keeps every enabled skill in the slash-token resolution map', () => {
    const skills = selectEnabledSkillDefinitions(storedSkills)
    const instructionBySlug = new Map(skills.map(({ name, instruction }) => [name, instruction]))

    expect(resolveSkillTokenInstructions('/research /user-authored', instructionBySlug)).toEqual([
      'TASK_SKILL_BODY',
      'USER_AUTHORED_SKILL_BODY',
    ])
  })
})

describe('buildVolatileSystemNotes', () => {
  it('wires volatile notes into the front system block', () => {
    const volatileSystemPrompt = 'Current date/time: Friday, July 10, 2026 at 9:00 AM GMT-3'
    const currentUserMessage = { role: 'user' as const, content: 'What changed?' }

    const notes = buildVolatileSystemNotes({
      volatileSystemPrompt,
      voiceNotes: ['Voice mode is active.'],
      skillSystemMessages: ['Follow project style.'],
      askResponsesNote: 'Ask responses: concise',
    })

    expect(notes[0]).toBe(volatileSystemPrompt)
    expect(notes).toEqual([
      volatileSystemPrompt,
      'Voice mode is active.',
      'Follow project style.',
      'Ask responses: concise',
    ])
    const input = assembleBuiltInModelInput(
      'stable prompt',
      [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        currentUserMessage,
      ],
      notes,
    )

    const messages = [{ role: 'system' as const, content: input.system }, ...input.messages]

    expect(input.system).toBe(`stable prompt\n\n${notes.join('\n\n')}`)
    expect(messages.slice(1).every(({ role }) => role !== 'system')).toBeTrue()
    expect(input.messages.at(-1)).toEqual(currentUserMessage)
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

describe('createModel (managed Tinfoil usage)', () => {
  it('forces encrypted streaming usage on for the system provider and exposes normalized receipt headers', async () => {
    const { client, requestBodies } = createTinfoilFetchClient()
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(client as never)

    try {
      const model = await createModel({ ...defaultModelGlm52, apiKey: null }, () => stubProxyFetch)
      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        providerOptions: { tinfoil: { stream_options: { include_usage: false } } },
      })
      const parts = await Array.fromAsync(result.stream)
      const body = JSON.parse(requestBodies[0]) as CapturedOpenAiBody
      const finish = parts.find((part) => part.type === 'finish')

      expect(body.stream_options).toEqual({ include_usage: true })
      expect(result.response?.headers?.['x-inference-usage-receipt']).toBe('iu1.payload.signature')
      expect(finish).toMatchObject({
        type: 'finish',
        usage: {
          inputTokens: { total: 16 },
          outputTokens: { total: 2 },
        },
      })
    } finally {
      getSystemClient.mockRestore()
    }
  })

  it('does not request streaming usage for a user-added Tinfoil model', async () => {
    const { client, requestBodies } = createTinfoilFetchClient()
    const getUserClient = spyOn(tinfoilClient, 'getTinfoilClient').mockResolvedValue(client as never)

    try {
      const model = await createModel(
        { ...defaultModelGlm52, id: 'user-glm', isSystem: 0, apiKey: 'user-key' },
        () => stubProxyFetch,
      )
      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      })
      await Array.fromAsync(result.stream)
      const body = JSON.parse(requestBodies[0]) as CapturedOpenAiBody

      expect(body.stream_options).toBeUndefined()
    } finally {
      getUserClient.mockRestore()
    }
  })

  it('does not request streaming usage for a non-GLM system Tinfoil model', async () => {
    const { client, requestBodies } = createTinfoilFetchClient()
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(client as never)

    try {
      const model = await createModel(
        { ...defaultModelGlm52, id: 'future-system-tinfoil', model: 'future-system-model', apiKey: null },
        () => stubProxyFetch,
      )
      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      })
      await Array.fromAsync(result.stream)
      const body = JSON.parse(requestBodies[0]) as CapturedOpenAiBody

      expect(body.stream_options).toBeUndefined()
    } finally {
      getSystemClient.mockRestore()
    }
  })
})

describe('aiFetchStreamingResponse (managed Tinfoil receipt callback)', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  const init: RequestInit = {
    body: JSON.stringify({
      id: 'thread-id',
      messages: [{ id: 'user-message', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    }),
  }

  it('awaits the authenticated receipt POST before the final chat stream settles', async () => {
    const receipt = 'iu1.awaited.signature'
    const systemClient = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      fetch: async () => completedSse(receipt),
    }
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(systemClient as never)
    const requests: Request[] = []
    let resolveReceiptResponse: ((response: Response) => void) | undefined
    const receiptResponse = new Promise<Response>((resolve) => {
      resolveReceiptResponse = resolve
    })
    const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
      fetch: async (input) => {
        requests.push(input as Request)
        return receiptResponse
      },
    })

    try {
      const response = await aiFetchStreamingResponse({
        init,
        modelId: defaultModelGlm52.id,
        httpClient,
        getProxyFetch: () => stubProxyFetch,
      })
      const responseState = { settled: false }
      const responseBody = response.text().finally(() => {
        responseState.settled = true
      })

      await pumpShortClockUntil(() => requests.length === 1)

      expect(responseState.settled).toBeFalse()
      expect(requests[0].url).toBe('https://app.example.com/v1/inference-usage/receipts')
      expect(requests[0].headers.get('authorization')).toBe('Bearer session-token')
      expect(await requests[0].json()).toEqual({
        receipt,
        promptTokens: 16,
        completionTokens: 2,
        totalTokens: 18,
      })

      resolveReceiptResponse?.(new Response(null, { status: 204 }))
      await pumpClockUntil(() => responseState.settled)
      expect(await responseBody).toContain('finish')
    } finally {
      getSystemClient.mockRestore()
    }
  })

  it('continues the chat when the awaited receipt POST returns an error status', async () => {
    const systemClient = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      fetch: async () => completedSse('iu1.failed.signature'),
    }
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(systemClient as never)
    const requests: Request[] = []
    const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
      fetch: async (input) => {
        requests.push(input as Request)
        return new Response(null, { status: 503 })
      },
    })

    try {
      const response = await aiFetchStreamingResponse({
        init,
        modelId: defaultModelGlm52.id,
        httpClient,
        getProxyFetch: () => stubProxyFetch,
      })
      const responseState = { settled: false }
      const responseBody = response.text().finally(() => {
        responseState.settled = true
      })

      await pumpClockUntil(() => responseState.settled)

      expect(requests).toHaveLength(1)
      expect(await responseBody).toContain('finish')
    } finally {
      getSystemClient.mockRestore()
    }
  })

  it('waits for a hanging tool-loop receipt timeout before starting the next upstream step', async () => {
    const upstreamRequests: string[] = []
    const systemClient = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      fetch: async (_input: RequestInfo | URL, upstreamInit?: RequestInit) => {
        const stepNumber = upstreamRequests.length + 1
        upstreamRequests.push(String(upstreamInit?.body))
        if (stepNumber === 1) {
          return new Response(
            `${[
              {
                id: 'tool-step',
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'skill-call',
                          function: { name: 'skill', arguments: '{"name":"weather"}' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
              },
              {
                id: 'tool-step',
                choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
              },
            ]
              .map((chunk) => `data: ${JSON.stringify(chunk)}`)
              .join('\n\n')}\n\ndata: [DONE]\n\n`,
            {
              headers: {
                'Content-Type': 'text/event-stream',
                'x-inference-usage-receipt': 'iu1.first.signature',
              },
            },
          )
        }
        return new Response(
          `${[
            {
              id: 'final-step',
              choices: [{ delta: { content: 'Tool result used' }, finish_reason: null }],
              usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
            },
            {
              id: 'final-step',
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 24, completion_tokens: 7, total_tokens: 31 },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}`)
            .join('\n\n')}\n\ndata: [DONE]\n\n`,
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'x-inference-usage-receipt': 'iu1.second.signature',
            },
          },
        )
      },
    }
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(systemClient as never)
    const receiptRequests: Request[] = []
    let firstReceiptSignal: AbortSignal | undefined
    const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
      fetch: async (input) => {
        const request = input as Request
        receiptRequests.push(request)
        if (receiptRequests.length !== 1) {
          return new Response(null, { status: 204 })
        }
        firstReceiptSignal = request.signal
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      },
    })

    try {
      const response = await aiFetchStreamingResponse({
        init,
        modelId: defaultModelGlm52.id,
        httpClient,
        getProxyFetch: () => stubProxyFetch,
      })
      const responseState = { settled: false }
      const responseBody = response.text().finally(() => {
        responseState.settled = true
      })

      await pumpShortClockUntil(() => receiptRequests.length === 1)

      expect(upstreamRequests).toHaveLength(1)
      expect(responseState.settled).toBeFalse()
      expect(firstReceiptSignal?.aborted).toBeFalse()

      await getClock().tickAsync(2_998)
      expect(upstreamRequests).toHaveLength(1)
      expect(firstReceiptSignal?.aborted).toBeFalse()
      await getClock().tickAsync(2)
      await pumpClockUntil(() => upstreamRequests.length === 2)
      await pumpClockUntil(() => receiptRequests.length === 2 && responseState.settled)

      expect(await Promise.all(receiptRequests.map((request) => request.json()))).toEqual([
        {
          receipt: 'iu1.first.signature',
          promptTokens: 10,
          completionTokens: 3,
          totalTokens: 13,
        },
        {
          receipt: 'iu1.second.signature',
          promptTokens: 24,
          completionTokens: 7,
          totalTokens: 31,
        },
      ])
      expect(upstreamRequests).toHaveLength(2)
      expect(receiptRequests).toHaveLength(2)
      expect(firstReceiptSignal?.aborted).toBeTrue()
      expect(await responseBody).toContain('finish')
    } finally {
      getSystemClient.mockRestore()
    }
  })

  it('does not submit a receipt for an aborted partial upstream step', async () => {
    const abortController = new AbortController()
    const streamState = { pulls: 0, awaitingMore: false }
    const encoder = new TextEncoder()
    const systemClient = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      fetch: async (_input: RequestInfo | URL, upstreamInit?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamInit?.signal?.addEventListener(
              'abort',
              () => controller.error(upstreamInit.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          },
          pull(controller) {
            streamState.pulls++
            if (streamState.pulls === 1) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'partial-step',
                    choices: [{ delta: { content: 'Partial' }, finish_reason: null }],
                    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
                  })}\n\n`,
                ),
              )
              return
            }
            streamState.awaitingMore = true
          },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'x-inference-usage-receipt': 'iu1.partial.signature',
          },
        })
      },
    }
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(systemClient as never)
    const receiptRequests: Request[] = []
    const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
      fetch: async (input) => {
        receiptRequests.push(input as Request)
        return new Response(null, { status: 204 })
      },
    })

    try {
      const response = await aiFetchStreamingResponse({
        init: { ...init, signal: abortController.signal },
        modelId: defaultModelGlm52.id,
        httpClient,
        getProxyFetch: () => stubProxyFetch,
      })
      const responseState = { settled: false }
      const responseBody = response.text().then(
        (body) => ({ body }),
        () => ({ aborted: true }),
      )
      responseBody.finally(() => {
        responseState.settled = true
      })

      await pumpClockUntil(() => streamState.awaitingMore)
      abortController.abort(new DOMException('Interrupted', 'AbortError'))
      await pumpClockUntil(() => responseState.settled)

      expect(receiptRequests).toHaveLength(0)
      await responseBody
    } finally {
      getSystemClient.mockRestore()
    }
  })

  it.each([
    { status: 500, expectedKind: 'provider' },
    { status: 418, expectedKind: 'unknown' },
  ] as const)('logs only a stable error kind for managed stream failures', async ({ status, expectedKind }) => {
    const privateMessage = 'PRIVATE_STREAM_ERROR_MESSAGE'
    const privateCause = 'PRIVATE_STREAM_ERROR_CAUSE'
    const privateBody = 'PRIVATE_STREAM_ERROR_BODY'
    const systemClient = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: privateMessage, cause: privateCause, body: privateBody } }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    }
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(systemClient as never)
    const consoleSpies = setupConsoleSpy()
    const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
      fetch: async () => new Response(null, { status: 204 }),
    })

    try {
      const response = await aiFetchStreamingResponse({
        init,
        modelId: defaultModelGlm52.id,
        httpClient,
        getProxyFetch: () => stubProxyFetch,
      })
      const responseState = { settled: false }
      response.text().finally(() => {
        responseState.settled = true
      })

      await pumpClockUntil(() => responseState.settled)

      expect(consoleSpies.error.mock.calls).toEqual([['streamText error', { kind: expectedKind }]])
      const serializedConsoleCalls = serializeConsoleCalls(consoleSpies)
      expect(serializedConsoleCalls).not.toContain(privateMessage)
      expect(serializedConsoleCalls).not.toContain(privateCause)
      expect(serializedConsoleCalls).not.toContain(privateBody)
    } finally {
      consoleSpies.restore()
      getSystemClient.mockRestore()
    }
  })

  const toolCallValidationCases = [
    {
      toolName: 'PRIVATE_TOOL_NAME_FROM_PROMPT_PRIVATE_VALIDATION_MESSAGE',
      toolArguments: '{"secret":"PRIVATE_TOOL_ARGUMENTS"}',
      expectedWarning: 'Tool call references unknown tool, skipping',
      expectedKind: 'no_such_tool',
    },
    {
      toolName: 'skill',
      toolArguments: 'PRIVATE_TOOL_ARGUMENTS_PRIVATE_VALIDATION_MESSAGE',
      expectedWarning: 'Tool call has invalid input, skipping',
      expectedKind: 'invalid_tool_input',
    },
  ]

  it.each(toolCallValidationCases)('classifies $expectedKind without leaking tool call content', async (testCase) => {
    const { toolName, toolArguments, expectedWarning, expectedKind } = testCase
    const privateErrorMessage = 'PRIVATE_VALIDATION_MESSAGE'
    const upstreamState = { requests: 0 }
    const systemClient = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      fetch: async () => {
        upstreamState.requests++
        if (upstreamState.requests > 1) {
          return completedSse('')
        }
        return new Response(
          `${[
            {
              id: 'invalid-tool-step',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'invalid-skill-call',
                        function: { name: toolName, arguments: toolArguments },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'invalid-tool-step',
              choices: [{ delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}`)
            .join('\n\n')}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
    }
    const getSystemClient = spyOn(tinfoilClient, 'getSystemTinfoilClient').mockResolvedValue(systemClient as never)
    const consoleSpies = setupConsoleSpy()
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })
    const httpClient = createAuthenticatedClient('https://app.example.com/v1/', () => 'session-token', {
      fetch: async () => new Response(null, { status: 204 }),
    })

    try {
      const response = await aiFetchStreamingResponse({
        init,
        modelId: defaultModelGlm52.id,
        httpClient,
        getProxyFetch: () => stubProxyFetch,
        telemetry,
      })
      const responseState = { settled: false }
      response.text().finally(() => {
        responseState.settled = true
      })

      await pumpClockUntil(() => responseState.settled)

      expect(consoleSpies.warn).toHaveBeenCalledWith(expectedWarning)
      expect(telemetry.buildPayload('success')).toMatchObject({
        tool_call_validation_failure_count: 1,
        tool_call_validation_failure_kinds: [expectedKind],
      })
      const serializedConsoleCalls = serializeConsoleCalls(consoleSpies)
      const serializedTelemetry = JSON.stringify(telemetry.buildPayload('success'))
      for (const privateValue of [toolName, toolArguments, privateErrorMessage]) {
        expect(serializedConsoleCalls).not.toContain(privateValue)
        expect(serializedTelemetry).not.toContain(privateValue)
      }
    } finally {
      consoleSpies.restore()
      getSystemClient.mockRestore()
    }
  })
})

// The `thunderbolt` provider fetch (and, via the same one-liner, the system-tinfoil
// wrappedFetch) POSTs directly to our backend, bypassing the proxy — so it must
// self-identify the build. `withAppVersionHeader` is that injection primitive.
describe('withAppVersionHeader', () => {
  const env = import.meta.env as Record<string, unknown>
  let savedVersion: unknown

  beforeEach(() => {
    savedVersion = env.VITE_APP_VERSION
  })

  afterEach(() => {
    env.VITE_APP_VERSION = savedVersion
  })

  it('adds X-App-Version to the outgoing request without clobbering caller headers', async () => {
    env.VITE_APP_VERSION = '1.2.3'
    const base = capturingFetch()

    await withAppVersionHeader(base.fn)('https://cloud.example.com/v1/chat/completions', {
      headers: { Authorization: 'Bearer session-token' },
    })

    const headers = new Headers(base.received()?.init?.headers)
    expect(headers.get('X-App-Version')).toBe('1.2.3')
    expect(headers.get('Authorization')).toBe('Bearer session-token')
  })

  it('omits X-App-Version when VITE_APP_VERSION is unset', async () => {
    env.VITE_APP_VERSION = undefined
    const base = capturingFetch()

    await withAppVersionHeader(base.fn)('https://cloud.example.com/v1/chat/completions')

    expect(new Headers(base.received()?.init?.headers).has('X-App-Version')).toBe(false)
  })

  it('forwards preconnect from the base fetch', () => {
    const base = capturingFetch()
    expect(withAppVersionHeader(base.fn).preconnect).toBe(base.fn.preconnect)
  })

  it('raises the upgrade blocker on a 426 and still returns the response', async () => {
    // This hop targets our backend, so it is subject to the version gate and
    // must surface it — otherwise the model call just fails silently.
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener(appVersionUnsupported, listener)
    const gated: FetchFn = Object.assign(
      async () => new Response(JSON.stringify({ code: 'APP_VERSION_UNSUPPORTED' }), { status: 426 }),
      { preconnect: () => Promise.resolve(false) },
    )

    const response = await withAppVersionHeader(gated)('https://cloud.example.com/v1/chat/completions')

    expect(events).toHaveLength(1)
    expect(response.status).toBe(426)
    window.removeEventListener(appVersionUnsupported, listener)
    resetAppVersionBlockedForTesting()
  })

  it('does not raise the blocker on a successful response', async () => {
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener(appVersionUnsupported, listener)
    const base = capturingFetch()

    await withAppVersionHeader(base.fn)('https://cloud.example.com/v1/chat/completions')

    expect(events).toHaveLength(0)
    window.removeEventListener(appVersionUnsupported, listener)
  })
})
