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

import { inferenceModelHeader } from '@shared/inference-usage'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import { prepareAiRequestConfig, type PreparedAiRequestConfig } from '@/ai/fetch'
import { createModel as insertModel } from '@/dal/models'
import { updateSettings } from '@/dal/settings'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import * as realAgentCore from '@shared/agent-core'
import { tool } from 'ai'
import { z } from 'zod'
import { createClient } from '@/lib/http'
import { createToolset } from '@/lib/tools'
import { createConfigs } from '@/integrations/thunderbolt-pro/tools'
import { createTurnTelemetry } from '@/ai/turn-telemetry'
import { createWebToolBudget, webToolCaps } from '@/ai/web-tool-budget'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import type { RequestOptions } from '@/lib/http'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { Model } from '@/types'
import {
  createBuiltInAdapter,
  composeAppHarnessSystemPrompt,
  harnessSignature,
  isPiModelCandidate,
  resolvePiModel,
  type BuiltInAdapterOptions,
  type ResolvedPiModel,
} from './built-in-adapter'
import { createReceiptLifecycle, type BuildAppHarnessOptions, type PiModelDescriptor } from '@shared/agent-core'
import { appHarnessEnvironmentPrompt } from '@shared/agent-core/environment-prompt'
import { createPromptParts, type PromptParams } from '@/ai/prompt'
import type { AgentHarness, AgentHarnessEvent, AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { SecureClient } from 'tinfoil'

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
    supportsImages: false,
    ...overrides,
  },
  thinkingLevel: 'medium',
})

describe('isPiModelCandidate', () => {
  it('matches the production provider and tool-usage routing boundary', () => {
    expect(
      ['anthropic', 'openai', 'custom', 'openrouter', 'thunderbolt'].map((provider) =>
        isPiModelCandidate({ provider: provider as Model['provider'], toolUsage: 1 }),
      ),
    ).toEqual([true, true, true, true, true])
    expect(isPiModelCandidate({ provider: 'tinfoil', toolUsage: 1 })).toBe(true)
    expect(isPiModelCandidate({ provider: 'tinfoil', toolUsage: 0 })).toBe(true)
    expect(isPiModelCandidate({ provider: 'anthropic', toolUsage: 0 })).toBe(false)
  })
})

/** Real prompt parts, so these tests break if the `# Language` section moves out of the
 *  stable half or stops reaching this engine. */
const languagePromptParts = (appLanguage: PromptParams['appLanguage']) =>
  createPromptParts(
    {
      modelName: 'Test Model',
      profile: null,
      preferredName: '',
      location: {},
      localization: { distanceUnit: 'metric', temperatureUnit: 'c', timeFormat: '24h', currency: 'EUR' },
      integrationStatus: 'READY',
      hasWebTools: false,
      appLanguage,
    },
    new Date('2026-07-10T12:00:00Z'),
  )

describe('reply-language directive delivery', () => {
  it('carries the language directive and its named fallback into the harness prompt', () => {
    const { stablePrompt, volatilePrompt } = languagePromptParts('ja')
    const composed = composeAppHarnessSystemPrompt({
      stableSystemPrompt: stablePrompt,
      volatileSystemPrompt: volatilePrompt,
      supportsTools: true,
    })

    expect(composed).toContain('# Language')
    expect(composed).toContain('Reply in the language of the conversation.')
    expect(composed).toContain('or use Japanese if the conversation has none yet')
  })

  it('keeps the directive cacheable — in the stable half, ahead of the timestamp', () => {
    const { stablePrompt, volatilePrompt } = languagePromptParts('ja')
    const composed = composeAppHarnessSystemPrompt({
      stableSystemPrompt: stablePrompt,
      volatileSystemPrompt: volatilePrompt,
      supportsTools: true,
    })

    expect(stablePrompt).toContain('# Language')
    expect(volatilePrompt).not.toContain('# Language')
    expect(composed.indexOf('# Language')).toBeLessThan(composed.indexOf('Current date/time'))
  })

  it('rebuilds the harness when the app language changes mid-thread', () => {
    // Otherwise a live harness would keep instructing the previous fallback language.
    expect(harnessSignature(anthropic(), languagePromptParts('ja').stablePrompt)).not.toBe(
      harnessSignature(anthropic(), languagePromptParts('pt-BR').stablePrompt),
    )
  })
})

describe('composeAppHarnessSystemPrompt', () => {
  it.each([false, true])('describes coding tools only when supportsTools is true (%s)', (supportsTools) => {
    const composed = composeAppHarnessSystemPrompt({
      stableSystemPrompt: 'Stable instructions',
      volatileSystemPrompt: 'Current date/time: 2026-09-04',
      supportsTools,
    })

    for (const text of ['# Environment', '`bash`', '`read`', '`write`', '`edit`', '`render_html`']) {
      expect(composed.includes(text)).toBe(supportsTools)
    }
    expect(composed.startsWith('Stable instructions\n\n')).toBe(true)
    expect(composed).toContain('Client environment:')
    expect(composed.endsWith('\n\nCurrent date/time: 2026-09-04')).toBe(true)
  })
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

  it('changes when the openai-compat image capability changes', () => {
    expect(harnessSignature(openaiCompat(), 'sys')).not.toBe(
      harnessSignature(openaiCompat({ supportsImages: true }), 'sys'),
    )
  })
})

describe('resolvePiModel — image capability (vendor-gated)', () => {
  const contextFor = (model: Model): AgentAdapterContext =>
    ({ selectedModel: model, getProxyFetch: () => noopFetch }) as unknown as AgentAdapterContext
  const agentCore = {} as Parameters<typeof resolvePiModel>[0]
  const openaiModel = (vendor: string | null): Model =>
    ({ id: 'm', name: 'M', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-o', vendor, toolUsage: 1 }) as Model

  it('advertises image support for a vision-vendor model', async () => {
    const resolved = await resolvePiModel(agentCore, contextFor(openaiModel('openai')), null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: true })
  })

  it('does not advertise image support when the vendor is unknown (custom/local)', async () => {
    const resolved = await resolvePiModel(agentCore, contextFor(openaiModel(null)), null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: false })
  })
})

const tinfoilModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'system-glm',
    name: 'GLM 5.2',
    provider: 'tinfoil',
    model: 'glm-5-2',
    vendor: 'zhipu',
    apiKey: null,
    isSystem: 1,
    toolUsage: 1,
    contextWindow: 131_072,
    ...overrides,
  }) as Model

type SecureFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const createSecureClient = (
  fetchImpl: SecureFetch = async () => new Response(),
  baseURL = 'https://enclave.example.com/v1',
): SecureClient =>
  ({
    fetch: Object.assign(fetchImpl, { preconnect: () => Promise.resolve(false) }),
    getBaseURL: () => baseURL,
  }) as never

const tinfoilContext = (model: Model, overrides: Partial<AgentAdapterContext> = {}): AgentAdapterContext =>
  ({
    threadId: 'thread-1',
    selectedModel: model,
    mcpClients: [],
    reconnectClient: async () => null,
    httpClient: {},
    getProxyFetch: () => noopFetch,
    onAcpSessionId: async () => {},
    ...overrides,
  }) as AgentAdapterContext

const tinfoilAgentCore = { createReceiptLifecycle } as Parameters<typeof resolvePiModel>[0]

const requireDescriptor = <Kind extends PiModelDescriptor['kind']>(
  resolved: ResolvedPiModel | null,
  kind: Kind,
): Extract<PiModelDescriptor, { kind: Kind }> => {
  if (!resolved || resolved.descriptor.kind !== kind) {
    throw new Error(`Expected ${kind} descriptor`)
  }
  return resolved.descriptor as Extract<PiModelDescriptor, { kind: Kind }>
}

const assistantMessage = (): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'answer' }],
  api: 'openai-completions',
  provider: 'tinfoil',
  model: 'glm-5-2',
  usage: {
    input: 11,
    output: 2,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
})

const createHarnessEvents = () => {
  type Listener = Parameters<AgentHarness['subscribe']>[0]
  const listeners = new Set<Listener>()
  return {
    harness: {
      subscribe: (listener: Listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit: async (event: AgentHarnessEvent): Promise<void> => {
      for (const listener of listeners) {
        await listener(event)
      }
    },
  }
}

describe('resolvePiModel — Tinfoil', () => {
  it('resolves a managed model as a confidential descriptor and records Pi attestation', async () => {
    const client = createSecureClient()
    const getSystemTinfoilClient = mock(async () => client)
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })

    const resolved = await resolvePiModel(tinfoilAgentCore, tinfoilContext(tinfoilModel(), { telemetry }), null, {
      getSystemTinfoilClient,
    })

    expect(requireDescriptor(resolved, 'confidential')).toMatchObject({
      providerId: 'tinfoil',
      modelId: 'glm-5-2',
      vendor: 'zhipu',
      baseURL: 'https://enclave.example.com/v1',
      apiKey: 'thunderbolt-managed',
      reasoning: true,
      contextWindow: 131_072,
      supportsImages: false,
    })
    expect(getSystemTinfoilClient).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      engine: 'pi',
      provider: 'tinfoil',
      model_id: 'system-glm',
    })
    expect(telemetry.buildPayload('success')).toMatchObject({ attestation_ms: 0 })
  })

  it.each(['glm-5-2', 'deepseek-v4-flash'])(
    'sends the %s model header with SSO cookies or bearer auth',
    async (model) => {
      const calls: RequestInit[] = []
      const client = createSecureClient(async (_input, init) => {
        calls.push(init ?? {})
        return new Response()
      })
      const env: { VITE_AUTH_MODE?: string; VITE_APP_VERSION?: string } = import.meta.env
      const savedMode = env.VITE_AUTH_MODE
      const savedVersion = env.VITE_APP_VERSION
      const savedToken = getAuthToken()

      try {
        env.VITE_AUTH_MODE = 'sso'
        env.VITE_APP_VERSION = '1.2.3'
        clearAuthToken()
        const descriptor = requireDescriptor(
          await resolvePiModel(tinfoilAgentCore, tinfoilContext(tinfoilModel({ model })), null, {
            getSystemTinfoilClient: async () => client,
          }),
          'confidential',
        )
        await descriptor.fetch('https://cloud.example.com/v1/tinfoil/chat/completions', {
          headers: { Authorization: 'Bearer thunderbolt-managed', [inferenceModelHeader]: 'wrong-model' },
        })

        env.VITE_AUTH_MODE = undefined
        setAuthToken('session-token')
        await descriptor.fetch('https://cloud.example.com/v1/tinfoil/chat/completions')

        expect(new Headers(calls[0].headers).get(inferenceModelHeader)).toBe(model)
        expect(new Headers(calls[1].headers).get(inferenceModelHeader)).toBe(model)
        expect(calls[0].credentials).toBe('include')
        expect(new Headers(calls[0].headers).get('authorization')).toBeNull()
        expect(new Headers(calls[0].headers).get('x-app-version')).toBe('1.2.3')
        expect(calls[1].credentials).toBeUndefined()
        expect(new Headers(calls[1].headers).get('authorization')).toBe('Bearer session-token')
        expect(new Headers(calls[1].headers).get('x-app-version')).toBe('1.2.3')
      } finally {
        env.VITE_AUTH_MODE = savedMode
        env.VITE_APP_VERSION = savedVersion
        if (savedToken) {
          setAuthToken(savedToken)
        } else {
          clearAuthToken()
        }
      }
    },
  )

  it('evicts a managed client after a wedged transport error', async () => {
    const error = new TypeError("Cannot read properties of null (reading 'fetch')")
    const client = createSecureClient(async () => {
      throw error
    })
    const evictSystemTinfoilClient = mock(() => {})
    const descriptor = requireDescriptor(
      await resolvePiModel(tinfoilAgentCore, tinfoilContext(tinfoilModel()), null, {
        getSystemTinfoilClient: async () => client,
        evictSystemTinfoilClient,
      }),
      'confidential',
    )

    await expect(descriptor.fetch('https://enclave.example.com/v1/chat/completions')).rejects.toBe(error)
    expect(evictSystemTinfoilClient).toHaveBeenCalledTimes(1)
  })

  it('resolves BYOK directly as OpenAI-compatible without receipts', async () => {
    const error = Object.assign(new Error('key changed'), { name: 'KeyConfigMismatchError' })
    const client = createSecureClient(async (_input, init) => {
      expect(new Headers(init?.headers).has(inferenceModelHeader)).toBe(false)
      throw error
    })
    const getTinfoilClient = mock(async () => client)
    const evictUserTinfoilClient = mock(() => {})
    const profile = { modelId: 'user-model', providerOptions: { reasoningEffort: 'high' } } as never
    const model = tinfoilModel({
      id: 'user-model',
      model: 'private-model',
      vendor: 'openai',
      isSystem: 0,
      apiKey: 'user-key',
    })

    const resolved = await resolvePiModel(tinfoilAgentCore, tinfoilContext(model), profile, {
      getTinfoilClient,
      evictUserTinfoilClient,
    })
    const descriptor = requireDescriptor(resolved, 'openai-compat')

    expect(descriptor).toMatchObject({
      providerId: 'tinfoil',
      modelId: 'private-model',
      baseURL: 'https://enclave.example.com/v1',
      apiKey: 'user-key',
      reasoning: true,
      supportsImages: true,
    })
    expect('receipts' in descriptor).toBe(false)
    expect(getTinfoilClient).toHaveBeenCalledWith({
      trace_id: undefined,
      engine: 'pi',
      provider: 'tinfoil',
      model_id: 'user-model',
    })
    await expect(descriptor.fetch('https://enclave.example.com/v1/chat/completions')).rejects.toBe(error)
    expect(evictUserTinfoilClient).toHaveBeenCalledTimes(1)
  })

  it('rejects a BYOK model without an API key', async () => {
    await expect(resolvePiModel(tinfoilAgentCore, tinfoilContext(tinfoilModel({ isSystem: 0 })), null)).rejects.toThrow(
      'No API key provided for Tinfoil provider',
    )
  })

  it('surfaces attestation failure without invoking the legacy fetch', async () => {
    const error = new Error('Tinfoil attestation failed: endpoint unavailable')
    const model = tinfoilModel()
    const config = {
      model,
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {},
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
    } satisfies PreparedAiRequestConfig
    const aiFetch = mock(async () => new Response('legacy'))
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      aiFetch,
      loadAgentCore: async () => tinfoilAgentCore,
      prepareConfig: async () => config,
      getSystemTinfoilClient: async () => {
        throw error
      },
    })

    await expect(adapter.fetch({ body: '{}' }, tinfoilContext(model))).rejects.toBe(error)
    expect(aiFetch).toHaveBeenCalledTimes(0)
  })

  it('submits one terminal receipt for every managed Tinfoil model', async () => {
    const post = mock(async () => new Response())
    const resolved = await resolvePiModel(
      tinfoilAgentCore,
      tinfoilContext(tinfoilModel({ model: 'deepseek-v4-flash', vendor: 'deepseek' }), {
        httpClient: { post } as never,
      }),
      null,
      { getSystemTinfoilClient: async () => createSecureClient() },
    )
    const descriptor = requireDescriptor(resolved, 'confidential')
    const events = createHarnessEvents()
    descriptor.receipts.attach(events.harness)
    const message = assistantMessage()

    descriptor.receipts.completeProviderStep({ receipt: 'signed-receipt', message })
    await events.emit({ type: 'message_end', message })
    await events.emit({ type: 'message_end', message })

    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('inference-usage/receipts', {
      json: { receipt: 'signed-receipt', promptTokens: 16, completionTokens: 2, totalTokens: 18 },
      timeout: 3_000,
    })
  })

  it('reports a managed receipt POST failure without rejecting the terminal event', async () => {
    const error = new Error('receipt unavailable')
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const resolved = await resolvePiModel(
      tinfoilAgentCore,
      tinfoilContext(tinfoilModel(), {
        httpClient: {
          post: async () => {
            throw error
          },
        } as never,
      }),
      null,
      { getSystemTinfoilClient: async () => createSecureClient() },
    )
    const descriptor = requireDescriptor(resolved, 'confidential')
    const events = createHarnessEvents()
    descriptor.receipts.attach(events.harness)
    const message = assistantMessage()

    try {
      descriptor.receipts.completeProviderStep({ receipt: 'signed-receipt', message })
      await expect(events.emit({ type: 'message_end', message })).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith(error)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keys the harness cache by attested client identity', async () => {
    const firstClient = createSecureClient()
    const secondClient = createSecureClient()
    const resolveWith = (client: SecureClient) =>
      resolvePiModel(tinfoilAgentCore, tinfoilContext(tinfoilModel()), null, {
        getSystemTinfoilClient: async () => client,
      })

    const first = await resolveWith(firstClient)
    const same = await resolveWith(firstClient)
    const second = await resolveWith(secondClient)

    expect(first && harnessSignature(first, 'system')).toBe(same && harnessSignature(same, 'system'))
    expect(first && harnessSignature(first, 'system')).not.toBe(second && harnessSignature(second, 'system'))
  })
})

describe('createBuiltInAdapter engine telemetry', () => {
  it('records legacy when a Pi candidate falls back after model resolution', async () => {
    const model = {
      id: 'model-1',
      name: 'Unknown Claude',
      model: 'claude-unknown',
      provider: 'anthropic',
      apiKey: 'sk-a',
      toolUsage: 1,
    } as Model
    const config = {
      model,
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {},
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
    } satisfies PreparedAiRequestConfig
    const aiFetch = mock(async () => new Response('legacy'))
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      aiFetch,
      loadAgentCore: async () => ({ isKnownAnthropicModel: () => false }) as never,
      prepareConfig: async () => config,
    })
    const telemetry = createTurnTelemetry({ generateId: () => 'trace-1' })
    const context = {
      threadId: 'thread-1',
      selectedModel: model,
      mcpClients: [],
      reconnectClient: async () => null,
      httpClient: {},
      getProxyFetch: () => noopFetch,
      onAcpSessionId: async () => {},
      telemetry,
    } as unknown as AgentAdapterContext

    await adapter.fetch({ body: '{}' }, context)

    expect(aiFetch).toHaveBeenCalledTimes(1)
    expect(telemetry.getEngine()).toBe('legacy')
  })
})

describe('createBuiltInAdapter persistent harness', () => {
  it('reads the current bearer on every managed Tinfoil request without rebuilding the harness', async () => {
    const model = tinfoilModel()
    const config = {
      model,
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {},
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
    } satisfies PreparedAiRequestConfig
    const authToken = { current: 'first-token' }
    const authorizationHeaders: Array<string | null> = []
    const client = createSecureClient(async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization'))
      return new Response()
    })
    const buildCalls: BuildAppHarnessOptions[] = []
    const agentCore = {
      ...tinfoilAgentCore,
      buildAppHarness: async (options: BuildAppHarnessOptions) => {
        buildCalls.push(options)
        return {
          getTools: () => [],
          setTools: async () => {},
          prompt: async () => {
            await options.model.fetch('https://cloud.example.com/v1/tinfoil/chat/completions')
          },
          waitForIdle: async () => {},
          on: () => () => {},
          abort: async () => ({ aborted: true }),
          env: { remove: async () => {} },
        } as never
      },
      workspaceDirFor: (threadId: string) => `/workspace/${threadId}`,
      toPiAgentTools: async () => [],
      piHarnessToUiMessageStream: (_harness: AgentHarness, runPrompt: () => Promise<void>) =>
        new ReadableStream<Uint8Array>({
          start: async (controller) => {
            await runPrompt()
            controller.close()
          },
        }),
    } as never
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: async () => config,
      getSystemTinfoilClient: async () => client,
      getAuthToken: () => authToken.current,
      isSsoMode: () => false,
    })
    const request: RequestInit = {
      body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }),
    }

    await (await adapter.fetch(request, tinfoilContext(model))).text()
    authToken.current = 'second-token'
    await (await adapter.fetch(request, tinfoilContext(model))).text()

    expect(buildCalls).toHaveLength(1)
    expect(authorizationHeaders).toEqual(['Bearer first-token', 'Bearer second-token'])
  })

  it('submits each managed receipt through the current context client without rebuilding the harness', async () => {
    const model = tinfoilModel()
    const config = {
      model,
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {},
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
    } satisfies PreparedAiRequestConfig
    const receiptIds = ['first-receipt', 'second-receipt']
    const buildCalls: BuildAppHarnessOptions[] = []
    const agentCore = {
      ...tinfoilAgentCore,
      buildAppHarness: async (options: BuildAppHarnessOptions) => {
        buildCalls.push(options)
        if (options.model.kind !== 'confidential') {
          throw new Error('Expected confidential descriptor')
        }
        const descriptor = options.model
        const events = createHarnessEvents()
        const harness = {
          ...events.harness,
          getTools: () => [],
          setTools: async () => {},
          prompt: async () => {
            const receipt = receiptIds.shift()
            if (!receipt) {
              throw new Error('Expected a receipt for each prompt')
            }
            const message = assistantMessage()
            descriptor.receipts.completeProviderStep({ receipt, message })
            await events.emit({ type: 'message_end', message })
          },
          waitForIdle: async () => {},
          on: () => () => {},
          abort: async () => ({ aborted: true }),
          env: { remove: async () => {} },
        }
        descriptor.receipts.attach(harness as never)
        return harness as never
      },
      workspaceDirFor: (threadId: string) => `/workspace/${threadId}`,
      toPiAgentTools: async () => [],
      piHarnessToUiMessageStream: (_harness: AgentHarness, runPrompt: () => Promise<void>) =>
        new ReadableStream<Uint8Array>({
          start: async (controller) => {
            await runPrompt()
            controller.close()
          },
        }),
    } as never
    const firstBodies: RequestOptions['json'][] = []
    const secondBodies: RequestOptions['json'][] = []
    const firstPost = mock(async (_url: string, options?: RequestOptions) => {
      firstBodies.push(options?.json)
      return new Response()
    })
    const secondPost = mock(async (_url: string, options?: RequestOptions) => {
      secondBodies.push(options?.json)
      return new Response()
    })
    const client = createSecureClient()
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: async () => config,
      getSystemTinfoilClient: async () => client,
    })
    const request: RequestInit = {
      body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }),
    }

    await (await adapter.fetch(request, tinfoilContext(model, { httpClient: { post: firstPost } as never }))).text()
    await (await adapter.fetch(request, tinfoilContext(model, { httpClient: { post: secondPost } as never }))).text()

    expect(buildCalls).toHaveLength(1)
    expect(firstPost).toHaveBeenCalledTimes(1)
    expect(secondPost).toHaveBeenCalledTimes(1)
    expect(firstBodies).toEqual([{ receipt: 'first-receipt', promptTokens: 16, completionTokens: 2, totalTokens: 18 }])
    expect(secondBodies).toEqual([
      { receipt: 'second-receipt', promptTokens: 16, completionTokens: 2, totalTokens: 18 },
    ])
  })

  it('keeps every harness tool inactive when Tinfoil tool usage is off', async () => {
    const model = tinfoilModel({ toolUsage: 0 })
    const config = {
      model,
      profile: null,
      supportsTools: false,
      sourceCollector: [],
      toolset: { weather: {} as never },
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
    } satisfies PreparedAiRequestConfig
    const activeToolNames: Array<string[] | undefined> = []
    const harness = {
      getTools: () => [{ name: 'read' } as AgentTool],
      setTools: async (_tools: AgentTool[], active?: string[]) => void activeToolNames.push(active),
      prompt: async () => {},
      waitForIdle: async () => {},
      on: () => () => {},
      abort: async () => ({ aborted: true }),
      env: { remove: async () => {} },
    }
    const agentCore = {
      ...tinfoilAgentCore,
      buildAppHarness: async () => harness as never,
      workspaceDirFor: (threadId: string) => `/workspace/${threadId}`,
      toPiAgentTools: async () => [{ name: 'weather' } as AgentTool],
      piHarnessToUiMessageStream: (_harness: AgentHarness, runPrompt: () => Promise<void>) =>
        new ReadableStream<Uint8Array>({
          start: async (controller) => {
            await runPrompt()
            controller.close()
          },
        }),
    } as never
    const aiFetch = mock(async () => new Response('legacy'))
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      aiFetch,
      loadAgentCore: async () => agentCore,
      prepareConfig: async () => config,
      getSystemTinfoilClient: async () => createSecureClient(),
    })

    const response = await adapter.fetch(
      { body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }) },
      tinfoilContext(model),
    )
    await response.text()

    expect(activeToolNames).toEqual([[]])
    expect(aiFetch).toHaveBeenCalledTimes(0)
  })

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
    const steer = mock(async () => {})
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
        getActiveTools: () => [{ name: 'read' } as AgentTool],
        steer,
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
    const telemetry = createTurnTelemetry({ generateId: () => 'trace-pi' })
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
      telemetry,
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
      `stable prompt\n\nClient environment: web\n\n${appHarnessEnvironmentPrompt}\n\n${timestamp}`
    expect(seededSystemPrompts).toEqual([expectedPrompt('timestamp 1'), expectedPrompt('timestamp 3')])
    expect(firstSystemPrompt()).toBe(expectedPrompt('timestamp 2'))
    expect(secondSystemPrompt()).toBe(expectedPrompt('timestamp 3'))
    expect(harnesses).toHaveLength(2)
    expect(activeToolCalls).toEqual([['read']])
    expect(steer).toHaveBeenCalledTimes(1)
    expect(telemetry.getEngine()).toBe('pi')
  })
})

type ProviderToolCall = { name: string; args: Record<string, unknown> }
type ProviderRequest = {
  tools?: Array<{ function: { name: string } }>
  messages: Array<{
    role: string
    content: unknown
    tool_call_id?: string
    tool_calls?: Array<{ id: string }>
  }>
}

/** Simulate provider SSE at the HTTP boundary, keeping Pi serialization and execution real. */
const providerResponse = (reply: ProviderToolCall[] | string, requestId: number): Response => {
  const delta =
    typeof reply === 'string'
      ? { role: 'assistant', content: reply }
      : {
          role: 'assistant',
          tool_calls: reply.map((call, index) => ({
            index,
            id: `call_${requestId}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }
  const chunk = (delta: unknown, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: `completion_${requestId}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  return new Response(
    chunk(delta, null) + chunk({}, typeof reply === 'string' ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n',
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
}

/** Run real web tools and the production adapter against scripted provider responses. */
const createBudgetAdapter = (
  replies: Array<ProviderToolCall[] | string | ((init?: RequestInit) => Promise<Response>)>,
  prepareConfig?: BuiltInAdapterOptions['prepareConfig'],
) => {
  const budget = createWebToolBudget('auto')
  const requests: ProviderRequest[] = []
  const searches: string[] = []
  const writes: string[] = []
  const httpClient = createClient({
    prefixUrl: 'https://backend.test',
    fetch: async (input) => {
      const query = new URL(input instanceof Request ? input.url : String(input)).searchParams.get('q')!
      searches.push(query)
      return Response.json({
        results: [{ pageUrl: `https://source.test/${query}`, title: query, faviconUrl: null, previewImageUrl: null }],
      })
    },
  })
  const model = {
    id: 'budget-model',
    name: 'Budget model',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test',
    toolUsage: 1,
  } as Model
  const prepareFixtureConfig: typeof prepareAiRequestConfig = async ({ webToolBudget = budget }) => ({
    model,
    profile: null,
    supportsTools: true,
    sourceCollector: webToolBudget.sourceCollector,
    toolset: {
      ...createToolset(createConfigs(httpClient, webToolBudget.sourceCollector), new Map(), webToolBudget),
      save_report: tool({
        description: 'Save report',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => {
          writes.push(text)
          return 'saved'
        },
      }),
    },
    skills: [],
    mcpToolsMetadata: undefined,
    stableSystemPrompt: 'Complete the report.',
    volatileSystemPrompt: 'Now.',
  })
  const registrations = new Set<unknown>()
  const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
    prepareConfig: prepareConfig ?? prepareFixtureConfig,
    loadAgentCore: async () => ({
      ...realAgentCore,
      buildAppHarness: async (options) => {
        const harness = await realAgentCore.buildAppHarness(options)
        const on = harness.on.bind(harness)
        harness.on = (type, handler) => {
          const remove = on(type, handler)
          if (type === 'tool_result') {
            registrations.add(handler)
          }
          return () => {
            registrations.delete(handler)
            remove()
          }
        }
        return harness
      },
    }),
  })
  const context = {
    threadId: 'budget-regression',
    selectedModel: model,
    mcpClients: [],
    reconnectClient: async () => null,
    httpClient,
    onAcpSessionId: async () => {},
    webToolBudget: budget,
    getProxyFetch: () => async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(init?.body as string) as ProviderRequest)
      const reply = replies.shift()
      if (reply === undefined) {
        throw new Error('Unexpected extra provider request')
      }
      return typeof reply === 'function' ? reply(init) : providerResponse(reply, requests.length)
    },
  } as unknown as AgentAdapterContext
  const response = () =>
    adapter.fetch(
      {
        body: JSON.stringify({
          messages: [
            { id: 'budget-user', role: 'user', parts: [{ type: 'text', text: 'Research and save a report.' }] },
          ],
        }),
      },
      context,
    )
  const send = async () => (await response()).text()
  return { adapter, budget, context, response, send, requests, searches, writes, registrations }
}

describe('real Pi web-budget payload', () => {
  it('pairs a mixed batch, retains non-web tools and steers only once after concurrent denials', async () => {
    const run = createBudgetAdapter([
      [
        { name: 'search', args: { query: 'one', max_results: 10 } },
        { name: 'search', args: { query: 'two', max_results: 10 } },
        { name: 'search', args: { query: 'three', max_results: 10 } },
        { name: 'fetch_content', args: { url: 'https://denied.test' } },
        { name: 'save_report', args: { text: 'batched report' } },
      ],
      [{ name: 'save_report', args: { text: 'complete report' } }],
      'Finished [1] and [2].',
    ])
    try {
      const output = await run.send()
      expect(run.searches).toEqual(['one', 'two'])
      expect(run.writes).toEqual(['batched report', 'complete report'])
      expect(output).toContain('Finished [1] and [2].')
      expect(output).not.toContain('"type":"error"')
      expect(output).toContain('https://source.test/one')
      expect(output).toContain('https://source.test/two')
      for (const request of run.requests.slice(1)) {
        const names = request.tools?.map(({ function: fn }) => fn.name)
        expect(names).toContain('save_report')
        expect(names).toContain('read')
        expect(names).not.toContain('search')
        expect(names).not.toContain('fetch_content')
        expect(request.messages.filter(({ role }) => role === 'user')).toHaveLength(2)
        const callIds = request.messages.flatMap(({ tool_calls }) => tool_calls?.map(({ id }) => id) ?? [])
        expect(request.messages.filter(({ role }) => role === 'tool').map(({ tool_call_id }) => tool_call_id)).toEqual(
          callIds,
        )
      }
      const messages = run.requests[1]!.messages
      expect(messages.filter(({ role }) => role === 'tool')).toHaveLength(5)
      expect(messages.at(-1)?.role).toBe('user')
      expect(JSON.stringify(messages.at(-1)?.content)).toContain('coverage gaps')
      expect(run.registrations.size).toBe(0)
    } finally {
      run.adapter.disconnect()
    }
  })

  it('allows cached web calls at the cap until the first denial', async () => {
    const run = createBudgetAdapter([
      [
        { name: 'search', args: { query: 'one', max_results: 10 } },
        { name: 'search', args: { query: 'two', max_results: 10 } },
      ],
      [{ name: 'search', args: { query: 'one', max_results: 10 } }],
      'Done [1].',
    ])
    try {
      await run.send()
      expect(run.searches).toEqual(['one', 'two'])
      expect(run.budget.probe.exhaustedAttempts).toBe(0)
      expect(run.requests[2]!.tools?.map(({ function: fn }) => fn.name)).toContain('search')
      expect(run.requests[2]!.messages.filter(({ role }) => role === 'user')).toHaveLength(1)
    } finally {
      run.adapter.disconnect()
    }
  })

  it('reports an exhausted replay through the error stream without asking for evidence-free synthesis', async () => {
    const run = createBudgetAdapter(['Should not be requested'])
    await run.budget.execute('search', { query: 'one' }, async () => 'old evidence')
    await run.budget.execute('search', { query: 'two' }, async () => 'old evidence')
    run.context.regenerationRevision = 1
    try {
      const output = await run.send()
      expect(output).toContain('"type":"error"')
      expect(run.requests).toHaveLength(0)
    } finally {
      run.adapter.disconnect()
    }
  })
})

it('keeps real adapter citation metadata across a below-cap harness rebuild', async () => {
  await setupTestDatabase()
  const run = createBudgetAdapter(
    [
      [{ name: 'search', args: { query: 'one', max_results: 10 } }],
      'First [1].',
      [
        { name: 'search', args: { query: 'one', max_results: 10 } },
        { name: 'search', args: { query: 'two', max_results: 10 } },
      ],
      'Both [1] and [2].',
    ],
    prepareAiRequestConfig,
  )
  try {
    await insertModel(getDb(), { ...run.context.selectedModel, enabled: 1 })
    await updateSettings(getDb(), { integrations_pro_is_enabled: true })
    const first = await run.send()
    run.context.regenerationRevision = 1
    const retry = await run.send()
    expect(run.searches).toEqual(['one', 'two'])
    expect(first).toContain('https://source.test/one')
    expect(retry).toContain('https://source.test/one')
    expect(retry).toContain('https://source.test/two')
    expect(run.budget.sourceCollector).toMatchObject([
      { index: 1, url: 'https://source.test/one' },
      { index: 2, url: 'https://source.test/two' },
    ])
    const results = run.requests.at(-1)!.messages.filter(({ role }) => role === 'tool')
    expect(JSON.stringify(results[0]!.content)).toContain('[Source 1]')
    expect(JSON.stringify(results[1]!.content)).toContain('[Source 2]')
    expect(run.registrations.size).toBe(0)
  } finally {
    run.adapter.disconnect()
    await teardownTestDatabase()
  }
})

it('removes the budget listener after provider failure and restores web tools for the next user turn', async () => {
  const run = createBudgetAdapter([
    [
      { name: 'search', args: { query: 'one', max_results: 10 } },
      { name: 'search', args: { query: 'two', max_results: 10 } },
      { name: 'search', args: { query: 'denied', max_results: 10 } },
    ],
    async () =>
      Response.json({ error: { message: 'Invalid request', type: 'BadRequestError', code: 400 } }, { status: 400 }),
    [{ name: 'search', args: { query: 'fresh', max_results: 10 } }],
    'New turn.',
  ])
  try {
    expect(await run.send()).toContain('"type":"error"')
    expect(run.registrations.size).toBe(0)
    run.context.webToolBudget = createWebToolBudget('auto')
    await run.send()
    expect(run.searches).toEqual(['one', 'two', 'fresh'])
    expect(run.requests.at(-1)!.tools?.map(({ function: fn }) => fn.name)).toContain('search')
    expect(run.registrations.size).toBe(0)
  } finally {
    run.adapter.disconnect()
  }
})

it('removes the budget listener when the response consumer stops the live harness', async () => {
  const requested = Promise.withResolvers<void>()
  const run = createBudgetAdapter([
    async (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
        requested.resolve()
      }),
  ])
  try {
    const response = await run.response()
    await requested.promise
    expect(run.registrations.size).toBe(1)
    await response.body!.cancel()
    // Cancellation aborts Pi; the prompt's finally removes the turn-local hook.
    await Promise.resolve()
    expect(run.registrations.size).toBe(0)
  } finally {
    run.adapter.disconnect()
  }
})
