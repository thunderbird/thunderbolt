/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `harnessSignature` tests — the fingerprint that drives the per-thread harness
 * cache. A stable signature for unchanged config keeps the live harness; any
 * change to model / provider / key / base url / reasoning / thinking level /
 * system prompt must produce a different signature so a mid-thread config switch
 * rebuilds the harness instead of silently reusing the first turn's config.
 */

import '@/testing-library'

import { describe, expect, it, mock } from 'bun:test'
import type { PreparedAiRequestConfig } from '@/ai/fetch'
import { createWebToolBudget, webToolCaps } from '@/ai/web-tool-budget'
import { mockProxyFetch } from '@/test-utils/proxy-fetch'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { Model } from '@/types'
import {
  createBuiltInAdapter,
  harnessSignature,
  resolvePiModel,
  type BuiltInAdapterOptions,
  type ResolvedPiModel,
} from './built-in-adapter'
import type { BuildAppHarnessOptions, PiModelDescriptor } from '@shared/agent-core'
import { appHarnessEnvironmentPrompt } from '@shared/agent-core/environment-prompt'
import type { AgentHarness, AgentTool } from '@earendil-works/pi-agent-core'

// `mockProxyFetch` is a `FetchFn`, a superset of Pi's descriptor `fetch` shape
// (`PiModelDescriptor['fetch']` has no `preconnect`), so it satisfies both —
// used as a descriptor's `fetch` below and as `getProxyFetch()`'s return value.
const noopFetch = mockProxyFetch

const anthropic = (overrides: Partial<Extract<PiModelDescriptor, { kind: 'anthropic' }>> = {}): ResolvedPiModel => ({
  descriptor: { kind: 'anthropic', modelId: 'claude-opus-4-8', apiKey: 'sk-a', fetch: noopFetch, ...overrides },
  thinkingLevel: 'medium',
})

const openaiCompat = (
  overrides: Partial<Extract<PiModelDescriptor, { kind: 'openai-compat' }>> = {},
): ResolvedPiModel => ({
  descriptor: {
    kind: 'openai-compat',
    providerId: 'openai',
    modelId: 'gpt-5',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-o',
    fetch: noopFetch,
    reasoning: false,
    supportsImages: false,
    ...overrides,
  },
  thinkingLevel: 'medium',
})

/** Adapts a stub harness's `prompt`/`waitForIdle` run into the `ReadableStream`
 *  `piHarnessToUiMessageStream` normally returns, closing once the run settles.
 *  Shared by every `agentCore` stub below — none of these tests assert on the
 *  stream's bytes, only on side effects the run produces. */
const drainPromptToStream = (_harness: AgentHarness, runPrompt: () => Promise<unknown>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      void runPrompt().then(() => controller.close())
    },
  })

/** Fields identical across this file's `agentCore` stubs — every test overrides
 *  at least `buildAppHarness` and `toPiAgentTools` to capture what it asserts on. */
const sharedAgentCoreStub = {
  isKnownAnthropicModel: () => true,
  workspaceDirFor: (threadId: string) => `/workspace/${threadId}`,
  piHarnessToUiMessageStream: drainPromptToStream,
}

describe('harnessSignature', () => {
  it('is stable for identical config', () => {
    expect(harnessSignature(anthropic(), 'sys')).toBe(harnessSignature(anthropic(), 'sys'))
  })

  it('changes when the model id changes', () => {
    expect(harnessSignature(anthropic(), 'sys')).not.toBe(
      harnessSignature(anthropic({ modelId: 'claude-sonnet-4-8' }), 'sys'),
    )
  })

  it('changes when the api key changes', () => {
    expect(harnessSignature(anthropic(), 'sys')).not.toBe(harnessSignature(anthropic({ apiKey: 'sk-b' }), 'sys'))
  })

  it('changes when the system prompt changes', () => {
    expect(harnessSignature(anthropic(), 'sys')).not.toBe(harnessSignature(anthropic(), 'other'))
  })

  it('changes when the thinking level changes', () => {
    const high: ResolvedPiModel = { ...anthropic(), thinkingLevel: 'high' }
    expect(harnessSignature(anthropic(), 'sys')).not.toBe(harnessSignature(high, 'sys'))
  })

  it('changes only when regenerate revision changes, not during normal transcript growth', () => {
    expect(harnessSignature(anthropic(), 'sys', 0)).toBe(harnessSignature(anthropic(), 'sys', 0))
    expect(harnessSignature(anthropic(), 'sys', 0)).not.toBe(harnessSignature(anthropic(), 'sys', 1))
  })

  it('does not collide across provider families', () => {
    expect(harnessSignature(anthropic(), 'sys')).not.toBe(harnessSignature(openaiCompat(), 'sys'))
  })

  it('changes when the openai-compat base url changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys')).not.toBe(
      harnessSignature(openaiCompat({ baseURL: 'https://other/v1' }), 'sys'),
    )
  })

  it('changes when the openai-compat reasoning flag changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys')).not.toBe(harnessSignature(openaiCompat({ reasoning: true }), 'sys'))
  })

  it('changes when the openai-compat context window changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys')).not.toBe(
      harnessSignature(openaiCompat({ contextWindow: 200000 }), 'sys'),
    )
  })

  it('does not embed the plaintext api key', () => {
    expect(harnessSignature(anthropic({ apiKey: 'super-secret-key' }), 'sys')).not.toContain('super-secret-key')
  })

  it('changes when the openai-compat image capability changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys')).not.toBe(
      harnessSignature(openaiCompat({ supportsImages: true }), 'sys'),
    )
  })
})

describe('resolvePiModel — image capability (vendor-gated)', () => {
  const agentCore = {} as Parameters<typeof resolvePiModel>[0]
  const openaiModel = (vendor: string | null): Model =>
    ({ id: 'm', name: 'M', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-o', vendor, toolUsage: 1 }) as Model

  it('advertises image support for a vision-vendor model', () => {
    const resolved = resolvePiModel(agentCore, openaiModel('openai'), () => noopFetch, null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: true })
  })

  it('does not advertise image support when the vendor is unknown (custom/local)', () => {
    const resolved = resolvePiModel(agentCore, openaiModel(null), () => noopFetch, null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: false })
  })
})

describe('fetchViaHarness — model resolution', () => {
  it('resolves the wire model from the fresh DB row, not the stale session-captured selectedModel', async () => {
    // Reproduces the production incident: the default Opus row's `model` alias
    // was renamed server-side (opus-4.8 -> opus-5) while a thread stayed open.
    // `context.selectedModel` is session-captured and never re-hydrates mid-thread
    // (see use-hydrate-chat-store.ts), so it keeps reporting the dead alias for
    // the life of the send context — only the config `prepareConfig` fetches
    // fresh from the DB on every send should reach the wire.
    const baseModel = { id: 'model-1', name: 'Opus', provider: 'anthropic', apiKey: 'sk-a', toolUsage: 1 } as Model
    const staleSelectedModel: Model = { ...baseModel, model: 'opus-4.8' }
    const agent = { id: 'built-in', type: 'built-in' } as Agent

    const freshConfig = (modelAlias: string): PreparedAiRequestConfig => ({
      model: { ...baseModel, model: modelAlias },
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {},
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable prompt',
      volatileSystemPrompt: 'now',
    })
    // Two sends, each fetching its own fresh row — the second alias (opus-6)
    // simulates a further rename mid-thread, which must drift the harness
    // signature and rebuild rather than reuse the first send's cached harness.
    const configs = [freshConfig('opus-5'), freshConfig('opus-6')]
    const prepareConfig = mock(async () => configs.shift()!)

    const buildModelIds: string[] = []
    const buildHarness = async (options: BuildAppHarnessOptions): Promise<AgentHarness> => {
      buildModelIds.push(options.model.kind === 'anthropic' ? options.model.modelId : 'n/a')
      return {
        getTools: () => [],
        setTools: async () => {},
        setActiveTools: async () => {},
        prompt: async () => {},
        waitForIdle: async () => {},
        on: () => () => {},
        abort: async () => {},
        env: { remove: async () => {} },
      } as unknown as AgentHarness
    }
    const agentCore = {
      ...sharedAgentCoreStub,
      buildAppHarness: buildHarness,
      toPiAgentTools: async () => [],
    } as unknown as Awaited<ReturnType<NonNullable<BuiltInAdapterOptions['loadAgentCore']>>>

    const adapter = createBuiltInAdapter(agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: prepareConfig as NonNullable<BuiltInAdapterOptions['prepareConfig']>,
    })
    const context = {
      threadId: 'thread-1',
      selectedModel: staleSelectedModel,
      mcpClients: [],
      reconnectClient: async () => null,
      httpClient: {},
      getProxyFetch: () => noopFetch,
      regenerationRevision: 0,
    } as unknown as AgentAdapterContext
    const send = async (): Promise<void> => {
      const response = await adapter.fetch(
        { body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) },
        context,
      )
      await response.text()
    }

    await send()
    await send()

    // Both sends used the fresh alias fetched for that send — never the stale
    // 'opus-4.8' the session captured — and the second send rebuilt the harness
    // (two build calls) because the fresh row's alias drifted between sends.
    expect(buildModelIds).toEqual(['opus-5', 'opus-6'])
  })
})

describe('createBuiltInAdapter persistent harness', () => {
  it('refreshes prompt/tools, rebuilds for regeneration, and applies the Pi web-budget floor', async () => {
    const model = {
      id: 'model-1',
      name: 'Claude',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      apiKey: 'sk-a',
      toolUsage: 1,
    } as Model
    const agent = { id: 'built-in', type: 'built-in' } as Agent
    const toolsets: PreparedAiRequestConfig['toolset'][] = [
      { first: {} } as unknown as PreparedAiRequestConfig['toolset'],
      { second: {} } as unknown as PreparedAiRequestConfig['toolset'],
      { third: {} } as unknown as PreparedAiRequestConfig['toolset'],
    ]
    const configs = toolsets.map(
      (toolset, index): PreparedAiRequestConfig => ({
        model,
        profile: null,
        supportsTools: true,
        sourceCollector: [],
        toolset,
        skills: [
          {
            name: 'review',
            description: 'Use for reviews.',
            instruction: 'Follow project style.',
          },
        ],
        mcpToolsMetadata: undefined,
        stableSystemPrompt: 'stable prompt',
        volatileSystemPrompt: `timestamp ${index + 1}`,
      }),
    )
    const prepareConfig = mock(async () => configs.shift()!)
    const buildCalls: BuildAppHarnessOptions[] = []
    const seededSystemPrompts: string[] = []
    const setToolsCalls: Array<Array<{ tools: AgentTool[]; activeToolNames: string[] | undefined }>> = []
    const promptCalls: Array<{ text: string; images: unknown[] }> = []
    const activeToolCalls: string[][] = []
    const toPiCalls: PreparedAiRequestConfig['toolset'][] = []
    const harnesses: AgentHarness[] = []
    const buildHarness = async (options: BuildAppHarnessOptions): Promise<AgentHarness> => {
      buildCalls.push(options)
      const systemPrompt = options.systemPrompt
      seededSystemPrompts.push(
        typeof systemPrompt === 'function' ? await systemPrompt({} as never) : (systemPrompt ?? ''),
      )
      const setToolsForHarness: Array<{ tools: AgentTool[]; activeToolNames: string[] | undefined }> = []
      let toolResultHandler: (() => Promise<unknown> | unknown) | undefined
      setToolsCalls.push(setToolsForHarness)
      const harness = {
        getTools: () => [{ name: 'read' } as AgentTool],
        setTools: async (tools: AgentTool[], activeToolNames?: string[]) =>
          void setToolsForHarness.push({ tools, activeToolNames }),
        setActiveTools: async (toolNames: string[]) => void activeToolCalls.push(toolNames),
        prompt: async (text: string, promptOptions?: { images?: unknown[] }) => {
          promptCalls.push({ text, images: promptOptions?.images ?? [] })
          if (promptCalls.length === 1) {
            for (let call = 0; call <= webToolCaps.auto; call++) {
              await context.webToolBudget?.execute('search', { query: `query ${call}` }, async () => ({ call }))
            }
            await toolResultHandler?.()
          }
        },
        waitForIdle: async () => {},
        on: (type: string, handler: () => Promise<unknown> | unknown) => {
          if (type === 'tool_result') {
            toolResultHandler = handler
          }
          return () => {
            toolResultHandler = undefined
          }
        },
        abort: async () => ({ aborted: true }),
        env: { remove: async () => {} },
      } as unknown as AgentHarness
      harnesses.push(harness)
      return harness
    }
    const agentCore = {
      ...sharedAgentCoreStub,
      buildAppHarness: buildHarness,
      toPiAgentTools: async (toolset: PreparedAiRequestConfig['toolset']) => {
        toPiCalls.push(toolset)
        return Object.keys(toolset).map((name) => ({ name }) as AgentTool)
      },
    } as unknown as Awaited<ReturnType<NonNullable<BuiltInAdapterOptions['loadAgentCore']>>>
    const adapter = createBuiltInAdapter(agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: prepareConfig as NonNullable<BuiltInAdapterOptions['prepareConfig']>,
    })
    const context = {
      threadId: 'thread-1',
      selectedModel: model,
      mcpClients: [],
      reconnectClient: async () => null,
      httpClient: {},
      getProxyFetch: () => noopFetch,
      onAcpSessionId: async () => {},
      regenerationRevision: 0,
      webToolBudget: createWebToolBudget('auto'),
    } as unknown as AgentAdapterContext
    const request = (messages: unknown[]): RequestInit => ({ body: JSON.stringify({ messages }) })
    const send = async (init: RequestInit): Promise<void> => {
      const response = await adapter.fetch(init, context)
      await response.text()
    }

    await send(request([{ role: 'user', parts: [{ type: 'text', text: '/review' }] }]))
    context.webToolBudget = createWebToolBudget('auto')
    await send(
      request([
        { role: 'user', parts: [{ type: 'text', text: '/review' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
        { role: 'user', parts: [{ type: 'text', text: 'second' }] },
      ]),
    )
    context.regenerationRevision = 1
    await send(
      request([
        { role: 'user', parts: [{ type: 'text', text: '/review' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
        { role: 'user', parts: [{ type: 'text', text: 'second' }] },
      ]),
    )

    expect(buildCalls).toHaveLength(2)
    expect(setToolsCalls.map((calls) => calls.length)).toEqual([2, 1])
    expect(setToolsCalls.flat().map((call) => call.activeToolNames)).toEqual([
      ['read', 'first'],
      ['read', 'second'],
      ['read', 'third'],
    ])
    expect(toPiCalls).toEqual(toolsets)
    expect(promptCalls.map((call) => call.text)).toEqual(['Follow project style.\n\n/review', 'second', 'second'])
    expect(buildCalls[0]?.history).toEqual([])
    expect(buildCalls[1]?.history).toEqual([
      { role: 'user', text: '/review' },
      { role: 'assistant', text: 'reply' },
    ])
    const firstSystemPrompt = buildCalls[0]?.systemPrompt as () => string
    const secondSystemPrompt = buildCalls[1]?.systemPrompt as () => string
    const expectedPrompt = (timestamp: string): string =>
      `stable prompt\n\n${appHarnessEnvironmentPrompt}\n\n${timestamp}`
    expect(seededSystemPrompts).toEqual([expectedPrompt('timestamp 1'), expectedPrompt('timestamp 3')])
    expect(firstSystemPrompt()).toBe(expectedPrompt('timestamp 2'))
    expect(secondSystemPrompt()).toBe(expectedPrompt('timestamp 3'))
    expect(harnesses).toHaveLength(2)
    expect(activeToolCalls).toEqual([[]])
  })
})
