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
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { Model } from '@/types'
import {
  createBuiltInAdapter,
  harnessSignature,
  type BuiltInAdapterOptions,
  type ResolvedPiModel,
} from './built-in-adapter'
import type { BuildAppHarnessOptions, PiModelDescriptor } from '@shared/agent-core'
import { APP_HARNESS_ENVIRONMENT_PROMPT } from '@shared/agent-core/environment-prompt'
import type { AgentHarness, AgentTool } from '@earendil-works/pi-agent-core'

const noopFetch = (async () => new Response('')) as PiModelDescriptor['fetch']

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
    ...overrides,
  },
  thinkingLevel: 'medium',
})

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
})

describe('createBuiltInAdapter persistent harness', () => {
  it('refreshes prompt/tools per send and rebuilds only for regenerate revision', async () => {
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
        mcpToolsMetadata: undefined,
        stableSystemPrompt: 'stable prompt',
        volatileSystemPrompt: `timestamp ${index + 1}`,
        systemPrompt: `stable prompt\n\ntimestamp ${index + 1}`,
      }),
    )
    const prepareConfig = mock(async () => configs.shift()!)
    const buildCalls: BuildAppHarnessOptions[] = []
    const seededSystemPrompts: string[] = []
    const setToolsCalls: Array<Array<{ tools: AgentTool[]; activeToolNames: string[] | undefined }>> = []
    const promptCalls: Array<{ text: string; images: unknown[] }> = []
    const toPiCalls: PreparedAiRequestConfig['toolset'][] = []
    const harnesses: AgentHarness[] = []
    const buildHarness = async (options: BuildAppHarnessOptions): Promise<AgentHarness> => {
      buildCalls.push(options)
      const systemPrompt = options.systemPrompt
      seededSystemPrompts.push(
        typeof systemPrompt === 'function' ? await systemPrompt({} as never) : (systemPrompt ?? ''),
      )
      const setToolsForHarness: Array<{ tools: AgentTool[]; activeToolNames: string[] | undefined }> = []
      setToolsCalls.push(setToolsForHarness)
      const harness = {
        getTools: () => [{ name: 'read' } as AgentTool],
        setTools: async (tools: AgentTool[], activeToolNames?: string[]) =>
          void setToolsForHarness.push({ tools, activeToolNames }),
        prompt: async (text: string, promptOptions?: { images?: unknown[] }) =>
          void promptCalls.push({ text, images: promptOptions?.images ?? [] }),
        waitForIdle: async () => {},
        on: () => () => {},
        abort: async () => ({ aborted: true }),
        env: { remove: async () => {} },
      } as unknown as AgentHarness
      harnesses.push(harness)
      return harness
    }
    const agentCore = {
      isKnownAnthropicModel: () => true,
      buildAppHarness: buildHarness,
      workspaceDirFor: (threadId: string) => `/workspace/${threadId}`,
      toPiAgentTools: async (toolset: PreparedAiRequestConfig['toolset']) => {
        toPiCalls.push(toolset)
        return Object.keys(toolset).map((name) => ({ name }) as AgentTool)
      },
      piHarnessToUiMessageStream: (_harness: AgentHarness, runPrompt: () => Promise<unknown>) =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            void runPrompt().then(() => controller.close())
          },
        }),
    } as unknown as Awaited<ReturnType<NonNullable<BuiltInAdapterOptions['loadAgentCore']>>>
    const adapter = createBuiltInAdapter(agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: prepareConfig as NonNullable<BuiltInAdapterOptions['prepareConfig']>,
    })
    const context = {
      threadId: 'thread-1',
      selectedModel: model,
      selectedMode: { name: 'chat', systemPrompt: 'mode' },
      mcpClients: [],
      reconnectClient: async () => null,
      httpClient: {},
      getProxyFetch: () => noopFetch,
      onAcpSessionId: async () => {},
      regenerationRevision: 0,
    } as unknown as AgentAdapterContext
    const request = (messages: unknown[]): RequestInit => ({ body: JSON.stringify({ messages }) })
    const send = async (init: RequestInit): Promise<void> => {
      const response = await adapter.fetch(init, context)
      await response.text()
    }

    await send(request([{ role: 'user', parts: [{ type: 'text', text: 'first' }] }]))
    await send(
      request([
        { role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
        { role: 'user', parts: [{ type: 'text', text: 'second' }] },
      ]),
    )
    context.regenerationRevision = 1
    await send(
      request([
        { role: 'user', parts: [{ type: 'text', text: 'first' }] },
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
    expect(promptCalls.map((call) => call.text)).toEqual(['first', 'second', 'second'])
    expect(buildCalls[0]?.history).toEqual([])
    expect(buildCalls[1]?.history).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply' },
    ])
    const firstSystemPrompt = buildCalls[0]?.systemPrompt as () => string
    const secondSystemPrompt = buildCalls[1]?.systemPrompt as () => string
    const expectedPrompt = (timestamp: string): string =>
      `stable prompt\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}\n\n${timestamp}`
    expect(seededSystemPrompts).toEqual([expectedPrompt('timestamp 1'), expectedPrompt('timestamp 3')])
    expect(firstSystemPrompt()).toBe(expectedPrompt('timestamp 2'))
    expect(secondSystemPrompt()).toBe(expectedPrompt('timestamp 3'))
    expect(harnesses).toHaveLength(2)
  })
})
