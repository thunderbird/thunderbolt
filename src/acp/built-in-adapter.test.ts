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

import { tinfoilSession } from '@/lib/tinfoil-session'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { defaultModels } from '@shared/defaults/models'
import { inferenceModelHeader } from '@shared/inference-usage'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { i18n } from '@lingui/core'
import { clearImageSupportCache, setCachedImageSupport } from '@/ai/image-support'
import { addSkillTool, prepareAiRequestConfig, type PreparedAiRequestConfig } from '@/ai/fetch'
import { createEvalAdapterContext } from '@/ai/eval/runner'
import { createModel as insertModel } from '@/dal/models'
import {
  saveProviderConnection,
  saveProviderConnectionInTransaction,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { updateSkill } from '@/dal/skills'
import { useConfigStore } from '@/api/config-store'
import { updateSettings } from '@/dal/settings'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getTransformer } from '@/files/transformers'
import { defaultSkillResearch } from '@/defaults/skills'
import * as realAgentCore from '@shared/agent-core'
import { tool } from 'ai'
import { z } from 'zod'
import { createClient } from '@/lib/http'
import { createToolset } from '@/lib/tools'
import { createConfigs } from '@/integrations/thunderbolt-pro/tools'
import { createTurnTelemetry } from '@/ai/turn-telemetry'
import { createWebToolBudget, webToolCaps } from '@/ai/web-tool-budget'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import { getLocalSetting } from '@/stores/local-settings-store'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { Model, ThunderboltUIMessage } from '@/types'
import { pageController } from '@/pages/page-controller'
import { browserController } from '@/browser/browser-controller'
import * as tauriCore from '@tauri-apps/api/core'
import * as tauriOs from '@tauri-apps/plugin-os'
import { useChatStore } from '@/chats/chat-store'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import {
  createBuiltInAdapter,
  composeAppHarnessSystemPrompt,
  harnessSignature,
  resolvePiModel,
  type BuiltInAdapterOptions,
  type ResolvedPiModel,
} from './built-in-adapter'
import { isPiModelCandidate } from './built-in-model-support'
import type { AppHarness } from '@shared/agent-core'
import { prepareBuiltInConversation, type BuiltInConversationDeps } from './built-in-conversation'
import type { BuildAppHarnessOptions, PiModelDescriptor } from '@shared/agent-core'
import { appHarnessDevelopmentPrompt, appHarnessEnvironmentPrompt } from '@shared/agent-core/environment-prompt'
import { createPromptParts, type PromptParams } from '@/ai/prompt'
import {
  FileError,
  type AgentHarness,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core'
import type { AttestedTinfoilClient } from '@/attestation/tinfoil'

const noopFetch = (async () => new Response('')) as PiModelDescriptor['fetch']
const compactionStub = {
  setReasoningEffort: async () => {},
  subscribe: () => () => {},
  getActiveTools: () => [],
  compaction: {
    revision: 0,
    prepareRequest: async (messages: AgentMessage[]) => messages,
    checkpoint: async () => undefined,
    abort: () => {},
  },
}

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
      ['anthropic', 'openai', 'custom', 'openrouter', 'thunderbolt', 'otari'].map((provider) =>
        isPiModelCandidate({ provider: provider as Model['provider'], toolUsage: 1 }),
      ),
    ).toEqual([true, true, true, true, true, true])
    expect(isPiModelCandidate({ provider: 'tinfoil', toolUsage: 1 })).toBe(true)
    expect(isPiModelCandidate({ provider: 'tinfoil', toolUsage: 0 })).toBe(true)
    expect(isPiModelCandidate({ provider: 'anthropic', toolUsage: 0 })).toBe(false)
  })
})

/** Real prompt parts to verify stable instructions reach the harness and drive cache invalidation. */
const testPromptParts = (
  appLanguage: PromptParams['appLanguage'],
  availableToolNames: PromptParams['availableToolNames'] = [],
) =>
  createPromptParts(
    {
      modelName: 'Test Model',
      profile: null,
      preferredName: '',
      location: {},
      localization: { distanceUnit: 'metric', temperatureUnit: 'c', timeFormat: '24h', currency: 'EUR' },
      integrationStatus: 'READY',
      availableToolNames,
      appLanguage,
    },
    new Date('2026-07-10T12:00:00Z'),
  )

describe('reply-language directive delivery', () => {
  it('carries the language directive and its named fallback into the harness prompt', () => {
    const { stablePrompt, volatilePrompt } = testPromptParts('ja')
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
    const { stablePrompt, volatilePrompt } = testPromptParts('ja')
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
    expect(harnessSignature(anthropic(), testPromptParts('ja').stablePrompt)).not.toBe(
      harnessSignature(anthropic(), testPromptParts('pt-BR').stablePrompt),
    )
  })
})

describe('composeAppHarnessSystemPrompt', () => {
  it('updates the harness prompt and signature when web search becomes available or unavailable', () => {
    const unavailable = testPromptParts('en')
    const available = testPromptParts('en', ['search'])
    const compose = ({ stablePrompt, volatilePrompt }: ReturnType<typeof testPromptParts>) =>
      composeAppHarnessSystemPrompt({
        stableSystemPrompt: stablePrompt,
        volatileSystemPrompt: volatilePrompt,
        supportsTools: true,
      })

    expect(compose(unavailable)).toContain('Built-in web search is unavailable')
    expect(compose(available)).not.toContain('Built-in web search is unavailable')
    expect(compose(available)).toContain('Web lookups use the `search` tool.')
    expect(harnessSignature(anthropic(), unavailable.stablePrompt)).not.toBe(
      harnessSignature(anthropic(), available.stablePrompt),
    )
    expect(compose(testPromptParts('en'))).toBe(compose(unavailable))
  })

  it.each([false, true])('describes coding tools only when supportsTools is true (%s)', (supportsTools) => {
    const composed = composeAppHarnessSystemPrompt({
      stableSystemPrompt: 'Stable instructions',
      volatileSystemPrompt: 'Current date/time: 2026-09-04',
      supportsTools,
    })

    for (const text of ['# Environment', '`bash`', '`read`', '`write`', '`edit`', '`render_html`']) {
      expect(composed.includes(text)).toBe(supportsTools)
    }
    expect(composed.includes(appHarnessDevelopmentPrompt)).toBe(supportsTools)
    expect(composed.startsWith('Stable instructions\n\n')).toBe(true)
    expect(composed).toContain('Client environment:')
    expect(composed.endsWith('\n\nCurrent date/time: 2026-09-04')).toBe(true)
  })

  it.each([
    { location: 'computer', cwd: '/workspace', access: 'ask' },
    { location: 'ssh', environmentId: 'remote', cwd: '~/workspace', access: 'ask' },
  ] as const)('includes development verification for $location execution', (execution) => {
    const composed = composeAppHarnessSystemPrompt(
      { stableSystemPrompt: 'Stable instructions', volatileSystemPrompt: 'Now', supportsTools: true },
      execution,
    )
    expect(composed).toContain(appHarnessDevelopmentPrompt)
    expect(composed).toContain('AGENTS.md')
    expect(composed).toContain('Never claim tests passed without running them')
    expect(composed).not.toContain('simulated shell')
  })
})

describe('harnessSignature', () => {
  it('rebuilds when a saved SSH destination changes and rejects a deleted destination', () => {
    const environment = {
      id: crypto.randomUUID(),
      name: 'Test SSH',
      host: 'vm-one',
      authentication: 'agent' as const,
      cwd: '/remote',
      deletedAt: null,
    }
    const execution = {
      location: 'ssh' as const,
      environmentId: environment.id,
      cwd: '/remote',
      access: 'ask' as const,
    }
    try {
      useSshEnvironmentsStore.getState().saveEnvironment(environment)
      const first = harnessSignature(anthropic(), 'sys', 0, undefined, execution)
      useSshEnvironmentsStore.getState().saveEnvironment({ ...environment, host: 'vm-two' })
      expect(harnessSignature(anthropic(), 'sys', 0, undefined, execution)).not.toBe(first)
      useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
      expect(() => harnessSignature(anthropic(), 'sys', 0, undefined, execution)).toThrow('unavailable')
    } finally {
      useSshEnvironmentsStore.setState({ environments: {} })
    }
  })
  it('rebuilds a cached chat when it moves between project workspaces', () => {
    expect(harnessSignature(anthropic(), 'sys', 0, undefined, undefined, 'project-one')).not.toBe(
      harnessSignature(anthropic(), 'sys', 0, undefined, undefined, 'project-two'),
    )
  })

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

  it.each([undefined, 'generation-1'])('keys provider bindings by connection ID with revision %s', (revision) => {
    const resolved = { ...anthropic(), providerBinding: { connectionId: 'first', revision } }
    const equivalent = { ...anthropic(), providerBinding: { connectionId: 'first', revision } }
    const switched = { ...anthropic(), providerBinding: { connectionId: 'second', revision } }
    expect(harnessSignature(resolved, 'sys')).toBe(harnessSignature(equivalent, 'sys'))
    expect(harnessSignature(resolved, 'sys')).not.toBe(harnessSignature(switched, 'sys'))
  })

  it('keys the same connection by its captured credential generation', () => {
    const resolved = { ...anthropic(), providerBinding: { connectionId: 'first', revision: 'generation-1' } }
    const reconnected = { ...anthropic(), providerBinding: { connectionId: 'first', revision: 'generation-2' } }
    expect(harnessSignature(resolved, 'sys')).not.toBe(harnessSignature(reconnected, 'sys'))
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

describe('resolvePiModel — image capability', () => {
  const contextFor = (model: Model): AgentAdapterContext =>
    ({ selectedModel: model, getProxyFetch: () => noopFetch }) as never
  const agentCore = {} as Parameters<typeof resolvePiModel>[0]
  const openaiModel = { id: 'm', name: 'M', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-o', toolUsage: 1 } as Model

  afterEach(() => {
    clearImageSupportCache()
  })

  it('keeps images for a model whose support has not been detected, so the provider decides', async () => {
    const resolved = await resolvePiModel(agentCore, contextFor(openaiModel), null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: true })
  })

  it('keeps images for a model detected as reading them', async () => {
    setCachedImageSupport(openaiModel, 'supported')
    const resolved = await resolvePiModel(agentCore, contextFor(openaiModel), null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: true })
  })

  it('strips images only for a model detected as unable to read them', async () => {
    setCachedImageSupport(openaiModel, 'unsupported')
    const resolved = await resolvePiModel(agentCore, contextFor(openaiModel), null)
    expect(resolved?.descriptor).toMatchObject({ kind: 'openai-compat', supportsImages: false })
  })
})

describe('resolvePiModel — live provider transport', () => {
  it('keeps a cached Anthropic descriptor on the current proxy transport', async () => {
    const first = mock(async () => new Response('first server'))
    const next = mock(async () => new Response('next server'))
    const transport = { current: Object.assign(first, { preconnect: async () => false }) }
    const context = {
      selectedModel: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'key' } as Model,
      getProxyFetch: () => transport.current,
    } as unknown as AgentAdapterContext
    const resolved = await resolvePiModel({ isKnownAnthropicModel: () => true } as never, context, null)
    const send = resolved!.descriptor.fetch!
    expect(await (await send('https://api.anthropic.com/v1/messages')).text()).toBe('first server')
    transport.current = Object.assign(next, { preconnect: async () => false })
    expect(await (await send('https://api.anthropic.com/v1/messages')).text()).toBe('next server')
    expect(first).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('resolvePiModel — managed Anthropic', () => {
  it('routes Thunderbolt Opus through Pi native Messages with its public wire alias', async () => {
    const isKnownAnthropicModel = mock((modelId: string) => modelId === 'claude-opus-5')
    const model = {
      id: 'managed-opus',
      name: 'Opus 5',
      provider: 'thunderbolt',
      model: 'opus-5',
      vendor: 'anthropic',
      apiKey: null,
      toolUsage: 1,
      contextWindow: 300_000,
    } as Model
    const context = { selectedModel: model, getProxyFetch: () => noopFetch } as AgentAdapterContext

    const resolved = await resolvePiModel({ isKnownAnthropicModel } as never, context, null)

    expect(resolved?.descriptor).toMatchObject({
      kind: 'anthropic',
      modelId: 'opus-5',
      catalogModelId: 'claude-opus-5',
      // Derived from the configured cloud URL so a local `.env` override cannot flip it.
      baseURL: `${getLocalSetting('cloudUrl')}/chat`,
      contextWindow: 300_000,
      apiKey: 'thunderbolt',
    })
    expect(isKnownAnthropicModel).toHaveBeenCalledWith('claude-opus-5')
  })

  // pi-ai 0.82.1 has no claude-opus-5-5. Without the alias the shipped Opus row
  // would resolve to null and silently drop every chat to the legacy pipeline.
  it('takes the Pi path for the shipped Opus row with Opus 5 catalog metadata and its own wire slug', async () => {
    const shippedOpus = defaultModels.find(({ vendor }) => vendor === 'anthropic')!
    const model = { ...shippedOpus, apiKey: null } as Model
    const context = { selectedModel: model, getProxyFetch: () => noopFetch } as AgentAdapterContext

    const resolved = await resolvePiModel(realAgentCore, context, null)

    expect(resolved?.descriptor).toMatchObject({
      kind: 'anthropic',
      modelId: shippedOpus.model,
      catalogModelId: 'claude-opus-5',
      contextWindow: shippedOpus.contextWindow,
    })
    expect(resolved?.thinkingLevel).toBe('medium')
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

const createAttestedClient = (
  fetchImpl: SecureFetch = async () => new Response(),
  baseURL = 'https://enclave.example.com/v1',
): AttestedTinfoilClient =>
  ({
    fetch: Object.assign(fetchImpl, { preconnect: () => Promise.resolve(false) }),
    baseURL,
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

const tinfoilAgentCore = {} as Parameters<typeof resolvePiModel>[0]

const requireDescriptor = <Kind extends PiModelDescriptor['kind']>(
  resolved: ResolvedPiModel | null,
  kind: Kind,
): Extract<PiModelDescriptor, { kind: Kind }> => {
  if (!resolved || resolved.descriptor.kind !== kind) {
    throw new Error(`Expected ${kind} descriptor`)
  }
  return resolved.descriptor as Extract<PiModelDescriptor, { kind: Kind }>
}

describe('resolvePiModel — Tinfoil', () => {
  it('refreshes linked OAuth credentials once per request and never bypasses their binding', async () => {
    await setupTestDatabase()
    const access = spyOn(tinfoilSession, 'getAccessToken').mockResolvedValue('initial')
    const send = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer refreshed')
      return new Response()
    })
    try {
      const id = await getDb().transaction((tx) =>
        saveProviderConnectionInTransaction(tx, {
          provider: 'tinfoil',
          name: 'Private account',
          authMethod: 'oauth',
          credentials: { access_token: 'initial', refresh_token: 'refresh', expires_at: Date.now() + 120_000 },
        }),
      )
      const model = tinfoilModel({ isSystem: 0, providerConnectionId: id, oauthProvider: 'tinfoil', apiKey: 'stale' })
      const resolved = await resolvePiModel(tinfoilAgentCore, tinfoilContext(model), null, {
        getTinfoilClient: async () => createAttestedClient(send),
      })
      const descriptor = requireDescriptor(resolved, 'openai-compat')
      expect(access).toHaveBeenCalledTimes(1)
      expect(descriptor.apiKey).toBe('initial')
      access.mockResolvedValue('refreshed')
      await descriptor.fetch('https://enclave.example.com/v1/chat/completions', {
        headers: { Authorization: 'Bearer initial' },
      })
      expect(access).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledTimes(1)

      await getDb().transaction((tx) =>
        saveProviderConnectionInTransaction(tx, {
          id,
          provider: 'tinfoil',
          name: 'Replacement account',
          authMethod: 'oauth',
          credentials: {
            access_token: 'replacement',
            refresh_token: 'replacement-refresh',
            expires_at: Date.now() + 120_000,
          },
        }),
      )
      await expect(descriptor.fetch('https://enclave.example.com/v1/chat/completions')).rejects.toThrow(
        'connection changed',
      )
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      access.mockRestore()
      await teardownTestDatabase()
    }
  })

  it('uses fresh OAuth bearer tokens inside the direct encrypted transport, never the managed proxy', async () => {
    const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const access = spyOn(tinfoilSession, 'getAccessToken')
      .mockResolvedValueOnce('initial')
      .mockResolvedValue('refreshed')
    const client = createAttestedClient(async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer refreshed')
      expect(JSON.parse(init?.body as string).web_search_options).toBeUndefined()
      return new Response()
    })
    const managed = mock(async () => {
      throw new Error('must not use managed billing')
    })
    try {
      const model = tinfoilModel({ isSystem: 0, apiKey: null, oauthProvider: 'tinfoil', toolUsage: 1 })
      const resolved = await resolvePiModel(tinfoilAgentCore, tinfoilContext(model), null, {
        getTinfoilClient: async () => client,
        getSystemTinfoilClient: managed,
      })
      const descriptor = requireDescriptor(resolved, 'openai-compat')
      expect(descriptor.apiKey).toBe('initial')
      await descriptor.fetch('https://enclave.example.com/v1/chat/completions', {
        headers: { Authorization: 'Bearer initial' },
        method: 'POST',
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      })
      expect(access).toHaveBeenCalledTimes(2)
      expect(managed).not.toHaveBeenCalled()
    } finally {
      access.mockRestore()
      useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
    }
  })

  it('resolves a managed model as a confidential descriptor and records Pi attestation', async () => {
    const client = createAttestedClient()
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
      supportsImages: true,
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
      const client = createAttestedClient(async (_input, init) => {
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

        delete env.VITE_AUTH_MODE
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
        if (savedMode === undefined) {
          delete env.VITE_AUTH_MODE
        } else {
          env.VITE_AUTH_MODE = savedMode
        }
        if (savedVersion === undefined) {
          delete env.VITE_APP_VERSION
        } else {
          env.VITE_APP_VERSION = savedVersion
        }
        if (savedToken) {
          setAuthToken(savedToken)
        } else {
          clearAuthToken()
        }
      }
    },
  )

  it('evicts a managed client after an attestation failure', async () => {
    const error = Object.assign(new Error('attestation rejected'), { category: 'attestation' })
    const client = createAttestedClient(async () => {
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
    expect(evictSystemTinfoilClient).toHaveBeenCalledWith(client)
  })

  it.each(['high', 'max'] as const)('resolves BYOK with %s effort directly', async (effort) => {
    const error = Object.assign(new Error('key changed'), { category: 'attestation' })
    const client = createAttestedClient(async (_input, init) => {
      expect(new Headers(init?.headers).has(inferenceModelHeader)).toBe(false)
      throw error
    })
    const getTinfoilClient = mock(async () => client)
    const evictUserTinfoilClient = mock(() => {})
    const profile = { modelId: 'user-model', providerOptions: { reasoningEffort: effort } } as never
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
    expect(resolved?.thinkingLevel).toBe(effort)
    const descriptor = requireDescriptor(resolved, 'openai-compat')

    expect(descriptor).toMatchObject({
      providerId: 'tinfoil',
      modelId: 'private-model',
      baseURL: 'https://enclave.example.com/v1',
      apiKey: 'user-key',
      reasoning: true,
      supportsImages: true,
    })
    expect(getTinfoilClient).toHaveBeenCalledWith({
      trace_id: undefined,
      engine: 'pi',
      provider: 'tinfoil',
      model_id: 'user-model',
    })
    await expect(descriptor.fetch('https://enclave.example.com/v1/chat/completions')).rejects.toBe(error)
    expect(evictUserTinfoilClient).toHaveBeenCalledTimes(1)
    expect(evictUserTinfoilClient).toHaveBeenCalledWith(client)
  })

  it.each([0, 1])('keeps Tinfoil search in the visible agent tool loop (%s)', async (toolUsage) => {
    const original = useLocalSettingsStore.getState().cloudUrl
    useLocalSettingsStore.setState({ cloudUrl: '' })
    try {
      const client = createAttestedClient(async (_input, init) => {
        const body = JSON.parse(init?.body as string)
        expect(body.web_search_options).toBeUndefined()
        return new Response()
      })
      const model = tinfoilModel({ isSystem: 0, apiKey: 'own-key', toolUsage })
      const resolved = await resolvePiModel(tinfoilAgentCore, tinfoilContext(model), null, {
        getTinfoilClient: async () => client,
      })
      await requireDescriptor(resolved, 'openai-compat').fetch('https://enclave.example.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'test', messages: [] }),
      })
    } finally {
      useLocalSettingsStore.setState({ cloudUrl: original })
    }
  })

  it('rejects a BYOK model without an API key', async () => {
    await expect(resolvePiModel(tinfoilAgentCore, tinfoilContext(tinfoilModel({ isSystem: 0 })), null)).rejects.toThrow(
      'No API key provided for Tinfoil provider',
    )
  })

  describe('image support', () => {
    afterEach(() => {
      clearImageSupportCache()
    })

    it('strips images for a managed model declared text-only (GLM 5.3)', async () => {
      const getSystemTinfoilClient = mock(async () => createAttestedClient())
      const resolved = await resolvePiModel(
        tinfoilAgentCore,
        tinfoilContext(tinfoilModel({ model: 'glm-5-3' })),
        null,
        {
          getSystemTinfoilClient,
        },
      )
      expect(requireDescriptor(resolved, 'confidential')).toMatchObject({ modelId: 'glm-5-3', supportsImages: false })
    })

    it('strips images for a BYOK model detected as text-only', async () => {
      const getTinfoilClient = mock(async () => createAttestedClient())
      const model = tinfoilModel({ id: 'user-model', model: 'private-model', vendor: null, isSystem: 0, apiKey: 'k' })
      setCachedImageSupport(model, 'unsupported')

      const resolved = await resolvePiModel(tinfoilAgentCore, tinfoilContext(model), null, { getTinfoilClient })
      expect(requireDescriptor(resolved, 'openai-compat')).toMatchObject({
        modelId: 'private-model',
        supportsImages: false,
      })
    })
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

  it('keys the harness cache by attested client identity', async () => {
    const firstClient = createAttestedClient()
    const secondClient = createAttestedClient()
    const resolveWith = (client: AttestedTinfoilClient) =>
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
    const context: AgentAdapterContext = {
      threadId: 'thread-1',
      selectedModel: model,
      mcpClients: [],
      reconnectClient: async () => null,
      httpClient: {},
      getProxyFetch: () => noopFetch,
      onAcpSessionId: async () => {},
      telemetry,
    } as never

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
    const client = createAttestedClient(async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization'))
      return new Response()
    })
    const buildCalls: BuildAppHarnessOptions[] = []
    const agentCore = {
      ...tinfoilAgentCore,
      buildAppHarness: async (options: BuildAppHarnessOptions) => {
        buildCalls.push(options)
        return {
          ...compactionStub,
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
      workspaceDirFor: realAgentCore.workspaceDirFor,
      writeAgentWorkspaceFiles: async () => [],
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
      ...compactionStub,
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
      workspaceDirFor: realAgentCore.workspaceDirFor,
      writeAgentWorkspaceFiles: async () => [],
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
      getSystemTinfoilClient: async () => createAttestedClient(),
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
      { first: {} } as never,
      { second: {} } as never,
      { third: {} } as never,
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
      const resolveSystemPrompt = systemPrompt as Exclude<NonNullable<typeof systemPrompt>, string>
      seededSystemPrompts.push(await resolveSystemPrompt({} as never))
      const setToolsForHarness: Array<{ tools: AgentTool[]; activeToolNames: string[] | undefined }> = []
      let toolResultHandler: (() => Promise<void> | void) | undefined
      setToolsCalls.push(setToolsForHarness)
      const harness: AppHarness = {
        ...compactionStub,
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
        on: (type: string, handler: () => Promise<void> | void) => {
          if (type === 'tool_result') {
            toolResultHandler = handler
          }
          return () => {
            toolResultHandler = undefined
          }
        },
        abort: async () => ({ aborted: true }),
        env: { remove: async () => {} },
      } as never
      harnesses.push(harness)
      return harness
    }
    const agentCore: Awaited<ReturnType<NonNullable<BuiltInAdapterOptions['loadAgentCore']>>> = {
      isKnownAnthropicModel: () => true,
      buildAppHarness: buildHarness,
      workspaceDirFor: realAgentCore.workspaceDirFor,
      writeAgentWorkspaceFiles: async () => [],
      toPiAgentTools: async (toolset: PreparedAiRequestConfig['toolset']) => {
        toPiCalls.push(toolset)
        return Object.keys(toolset).map((name) => ({ name }) as AgentTool)
      },
      piHarnessToUiMessageStream: (_harness: AgentHarness, runPrompt: () => Promise<void>) =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            void runPrompt().then(() => controller.close())
          },
        }),
    } as never
    const adapter = createBuiltInAdapter(agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: prepareConfig as NonNullable<BuiltInAdapterOptions['prepareConfig']>,
    })
    const telemetry = createTurnTelemetry({ generateId: () => 'trace-pi' })
    const context: AgentAdapterContext = {
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
    } as never
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
      ['read', 'first', 'page_show_file'],
      ['read', 'second', 'page_show_file'],
      ['read', 'third', 'page_show_file'],
    ])
    expect(toPiCalls.map(({ page_show_file: _showFile, ...tools }) => tools)).toEqual(toolsets)
    expect(promptCalls.map((call) => call.text)).toEqual(['Follow project style.\n\n/review', 'second', 'second'])
    expect(buildCalls[0]?.history).toEqual([])
    expect(buildCalls[1]?.history).toEqual([
      { role: 'user', text: '/review' },
      { role: 'assistant', text: 'reply' },
    ])
    const firstSystemPrompt = buildCalls[0]?.systemPrompt as () => string
    const secondSystemPrompt = buildCalls[1]?.systemPrompt as () => string
    const expectedPrompt = (timestamp: string): string =>
      `stable prompt\n\nClient environment: web\n\n${appHarnessEnvironmentPrompt}\nFile changes, shell commands, and external actions require user approval. Reads run automatically. If denied, respect the decision; do not retry through another tool.\n\n${appHarnessDevelopmentPrompt}\n\n${timestamp}`
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
  onHarness?: (harness: AgentHarness) => void,
  extraConfig?: Partial<PreparedAiRequestConfig>,
  sshReply?: (request: Record<string, unknown>) => unknown,
) => {
  const budget = createWebToolBudget('auto')
  const requests: ProviderRequest[] = []
  const searches: string[] = []
  const writes: string[] = []
  const nativeCalls: Array<{ command: string; args: Record<string, unknown> }> = []
  const nativeCleanup = { pending: Promise.withResolvers<void>() }
  const invokeNative: ConstructorParameters<typeof realAgentCore.NativeExecutionEnv>[1] = async <T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    if (sshReply) {
      nativeCalls.push({ command, args })
      if (command === 'agent_ssh_request') {
        const request = args.request as Record<string, unknown>
        if (request.operation === 'cleanup') {
          nativeCleanup.pending.resolve()
          nativeCleanup.pending = Promise.withResolvers<void>()
        }
        return (await sshReply(request)) as T
      }
      return undefined as T
    }
    if (command !== 'agent_cleanup_output_files') {
      throw new Error(`Unexpected native command: ${command}`)
    }
    nativeCalls.push({ command, args })
    nativeCleanup.pending.resolve()
    nativeCleanup.pending = Promise.withResolvers<void>()
    return undefined as T
  }
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
    toolset: addSkillTool(
      {
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
      [{ name: 'research', description: 'Research', instruction: 'Research within the current web budget.' }],
      true,
      webToolBudget,
    ),
    skills: [{ name: 'research', description: 'Research', instruction: 'Research within the current web budget.' }],
    mcpToolsMetadata: undefined,
    stableSystemPrompt: 'Complete the report.',
    volatileSystemPrompt: 'Now.',
    ...extraConfig,
  })
  const registrations = new Set<unknown>()
  const workspaceRemoved = Promise.withResolvers<void>()
  const registrationRemoved = Promise.withResolvers<void>()
  const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
    prepareConfig: prepareConfig ?? prepareFixtureConfig,
    loadAgentCore: async () => ({
      ...realAgentCore,
      NativeExecutionEnv: class extends realAgentCore.NativeExecutionEnv {
        constructor(
          cwd: string,
          _invoke: ConstructorParameters<typeof realAgentCore.NativeExecutionEnv>[1],
          owner?: string,
        ) {
          super(cwd, invokeNative, owner)
        }
      },
      SshExecutionEnv: class extends realAgentCore.SshExecutionEnv {
        constructor(
          cwd: string,
          connection: ConstructorParameters<typeof realAgentCore.SshExecutionEnv>[1],
          _invoke: ConstructorParameters<typeof realAgentCore.SshExecutionEnv>[2],
          owner?: string,
        ) {
          super(cwd, connection, invokeNative, owner)
        }
      },
      removeAgentWorkspace: async (threadId) => {
        await realAgentCore.removeAgentWorkspace(threadId)
        workspaceRemoved.resolve()
      },
      buildAppHarness: async (options) => {
        const harness = await realAgentCore.buildAppHarness(options)
        onHarness?.(harness)
        const on = harness.on.bind(harness)
        harness.on = (type, handler) => {
          const remove = on(type, handler)
          if (type === 'tool_result') {
            registrations.add(handler)
          }
          return () => {
            registrations.delete(handler)
            remove()
            registrationRemoved.resolve()
          }
        }
        return harness
      },
    }),
  })
  const context = {
    threadId: 'budget-regression',
    execution: { location: 'sandbox', access: 'full' },
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
  const response = (
    messages: ThunderboltUIMessage[] = [
      { id: 'budget-user', role: 'user', parts: [{ type: 'text', text: 'Research and save a report.' }] },
    ],
  ) => adapter.fetch({ body: JSON.stringify({ messages }) }, context)
  const send = async (messages?: ThunderboltUIMessage[]) => (await response(messages)).text()
  return {
    adapter,
    budget,
    context,
    response,
    send,
    requests,
    searches,
    writes,
    registrations,
    nativeCalls,
    get nativeCleanup() {
      return nativeCleanup.pending.promise
    },
    workspaceRemoved: workspaceRemoved.promise,
    registrationRemoved: registrationRemoved.promise,
  }
}

const budgetSearchCalls = Array.from({ length: webToolCaps.auto }, (_, index) => ({
  name: 'search',
  args: { query: `query-${index}`, max_results: 10 },
}))

describe('real Pi approvals', () => {
  it('binds SSH coding tools and keeps full access on later turns without rebuilding the harness', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const environment = {
      id: crypto.randomUUID(),
      name: 'VM',
      host: 'orb',
      authentication: 'agent' as const,
      cwd: '/remote/project',
      deletedAt: null,
    }
    const files = new Map<string, number[]>()
    const harnesses: AgentHarness[] = []
    const run = createBudgetAdapter(
      [
        [{ name: 'write', args: { path: 'ssh.txt', content: 'remote only' } }],
        'Saved remotely.',
        [{ name: 'write', args: { path: 'full.txt', content: 'full access' } }],
        'Saved with full access.',
        [{ name: 'write', args: { path: 'later.txt', content: 'still full access' } }],
        'Saved again.',
      ],
      undefined,
      (harness) => harnesses.push(harness),
      undefined,
      (request) => {
        if (request.operation === 'resolve') {
          return `/remote/project/${request.path}`
        }
        if (request.operation === 'write') {
          files.set(request.path as string, request.content as number[])
          return
        }
        if (request.operation === 'cleanup') {
          return
        }
        throw new Error(`Unexpected SSH request: ${request.operation}`)
      },
    )
    try {
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      useSshEnvironmentsStore.getState().saveEnvironment(environment)
      run.context.execution = { location: 'ssh', environmentId: environment.id, cwd: environment.cwd, access: 'ask' }
      run.context.requestPermission = mock(async () => ({
        outcome: { outcome: 'selected' as const, optionId: 'allow' },
      }))
      expect(await run.send()).not.toContain('"type":"error"')
      expect(run.context.requestPermission).toHaveBeenCalledTimes(1)
      expect([...files.values()].map((bytes) => new TextDecoder().decode(new Uint8Array(bytes)))).toEqual([
        'remote only',
      ])
      expect(JSON.stringify(run.requests[0].messages)).toContain("user's SSH environment")
      expect(JSON.stringify(run.requests[0].tools)).not.toContain('local_app')
      run.context.execution = { ...run.context.execution, access: 'full' }
      const history: ThunderboltUIMessage[] = [
        { id: 'budget-user', role: 'user', parts: [{ type: 'text', text: 'Save a remote file.' }] },
        { id: 'ssh-reply', role: 'assistant', parts: [{ type: 'text', text: 'Saved remotely.' }] },
        { id: 'ssh-next', role: 'user', parts: [{ type: 'text', text: 'Save another file.' }] },
      ]
      expect(await run.send(history)).not.toContain('"type":"error"')
      expect(
        await run.send([
          ...history,
          { id: 'ssh-next-reply', role: 'assistant', parts: [{ type: 'text', text: 'Saved with full access.' }] },
          { id: 'ssh-later', role: 'user', parts: [{ type: 'text', text: 'Save one more file.' }] },
        ]),
      ).not.toContain('"type":"error"')
      expect(run.context.requestPermission).toHaveBeenCalledTimes(1)
      expect(harnesses).toHaveLength(1)
      expect([...files.values()].map((bytes) => new TextDecoder().decode(new Uint8Array(bytes)))).toEqual([
        'remote only',
        'full access',
        'still full access',
      ])
      expect(JSON.stringify(run.requests[2].messages)).toContain('The user enabled full access.')
      expect(JSON.stringify(run.requests[4].messages)).toContain('The user enabled full access.')
      expect(run.nativeCalls.some(({ command }) => command === 'agent_fs' || command === 'agent_exec')).toBe(false)
      const cleanup = run.nativeCleanup
      run.adapter.disconnect()
      await cleanup
    } finally {
      run.adapter.disconnect()
      useSshEnvironmentsStore.setState({ environments: {} })
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it('removes the retained sandbox after switching to this computer', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const run = createBudgetAdapter(['Sandbox ready.', 'Computer ready.'])
    const env = new realAgentCore.BrowserExecutionEnv({ cwd: realAgentCore.workspaceDirFor(run.context.threadId) })
    try {
      expect(await run.send()).not.toContain('"type":"error"')
      expect(await env.writeFile('kept.txt', 'sandbox file')).toMatchObject({ ok: true })
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      run.context.execution = { location: 'computer', cwd: '/chosen-folder', access: 'full' }
      expect(await run.send()).not.toContain('"type":"error"')
      expect(JSON.stringify(run.requests[1].messages)).toContain('real filesystem access')
      expect(await env.readTextFile('kept.txt')).toMatchObject({ ok: true, value: 'sandbox file' })
      run.adapter.disconnect()
      await run.workspaceRemoved
      expect(await env.exists('kept.txt')).toMatchObject({ ok: true, value: false })
    } finally {
      run.adapter.disconnect()
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it('retains native output through rebuilds and removes it after switching back to sandbox', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const run = createBudgetAdapter(['Computer ready.', 'Folder changed.', 'Sandbox ready.'])
    try {
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      run.context.execution = { location: 'computer', cwd: '/first-folder', access: 'full' }
      expect(await run.send()).not.toContain('"type":"error"')
      run.context.execution = { location: 'computer', cwd: '/second-folder', access: 'full' }
      expect(await run.send()).not.toContain('"type":"error"')
      run.context.execution = { location: 'sandbox', access: 'full' }
      expect(await run.send()).not.toContain('"type":"error"')
      expect(run.nativeCalls).toHaveLength(0)
      const cleaned = run.nativeCleanup
      run.adapter.disconnect()
      await Promise.all([cleaned, run.workspaceRemoved])
      expect(run.nativeCalls).toEqual([{ command: 'agent_cleanup_output_files', args: { owner: expect.any(String) } }])
    } finally {
      run.adapter.disconnect()
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it('cleans native output even when a replacement harness fails to build', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const onHarness = mock(() => {})
    const run = createBudgetAdapter(['Ready.'], undefined, onHarness)
    try {
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      run.context.execution = { location: 'computer', cwd: '/first-folder', access: 'full' }
      await run.send()
      onHarness.mockImplementation(() => {
        throw new Error('Harness build failed')
      })
      run.context.execution = { location: 'computer', cwd: '/second-folder', access: 'full' }
      await expect(run.send()).rejects.toThrow('Harness build failed')
      expect(run.nativeCalls).toHaveLength(0)
      const cleaned = run.nativeCleanup
      run.adapter.disconnect()
      await cleaned
      expect(run.nativeCalls).toEqual([{ command: 'agent_cleanup_output_files', args: { owner: expect.any(String) } }])
    } finally {
      run.adapter.disconnect()
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it('cleans a disconnected native rebuild after its pending abort and refuses to revive a disconnected adapter', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const abortStarted = Promise.withResolvers<void>()
    const releaseAbort = Promise.withResolvers<void>()
    const harnesses: AgentHarness[] = []
    const run = createBudgetAdapter(['Computer ready.', 'New lifetime ready.'], undefined, (harness) => {
      if (harnesses.length === 0) {
        const abort = harness.abort.bind(harness)
        harness.abort = async () => {
          abortStarted.resolve()
          await releaseAbort.promise
          return await abort()
        }
      }
      harnesses.push(harness)
    })
    try {
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      run.context.execution = { location: 'computer', cwd: '/first-folder', access: 'full' }
      await run.send()
      run.context.execution = { location: 'computer', cwd: '/second-folder', access: 'full' }
      const rebuilding = run.send()
      await abortStarted.promise
      const disconnectedCleanup = run.nativeCleanup
      const observeRebuild = async () => {
        try {
          await rebuilding
          return null
        } catch (error) {
          return error
        }
      }
      const rebuildingRejected = observeRebuild()
      run.adapter.disconnect()
      expect(run.nativeCalls).toHaveLength(0)
      await expect(run.send()).rejects.toMatchObject({ name: 'AbortError' })
      expect(harnesses).toHaveLength(1)
      releaseAbort.resolve()
      const [rebuildError] = await Promise.all([rebuildingRejected, disconnectedCleanup])
      expect(rebuildError).toMatchObject({ name: 'AbortError' })
      expect(harnesses).toHaveLength(1)
      expect(run.requests).toHaveLength(1)
      expect(run.nativeCalls).toEqual([{ command: 'agent_cleanup_output_files', args: { owner: expect.any(String) } }])
    } finally {
      releaseAbort.resolve()
      run.adapter.disconnect()
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it('gives overlapping adapter lifetimes separate native output ownership', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const runs = [createBudgetAdapter(['Ready.']), createBudgetAdapter(['Ready.'])]
    try {
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      for (const run of runs) {
        run.context.execution = { location: 'computer', cwd: '/same-folder', access: 'full' }
        await run.send()
      }
      const cleaned = runs.map((run) => run.nativeCleanup)
      runs[0].adapter.disconnect()
      await cleaned[0]
      expect(runs[0].nativeCalls).toHaveLength(1)
      expect(runs[1].nativeCalls).toHaveLength(0)
      runs[1].adapter.disconnect()
      await cleaned[1]
      const owners = runs.flatMap((run) => run.nativeCalls.map(({ args }) => args.owner))
      expect(owners).toHaveLength(2)
      expect(new Set(owners).size).toBe(2)
    } finally {
      for (const run of runs) {
        run.adapter.disconnect()
      }
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it.each([
    ['ask', 'allow', 1, 1],
    ['ask', 'deny', 1, 0],
    ['full', 'allow', 0, 1],
  ] as const)(
    'routes page opening %s / %s through a single approval gate',
    async (access, decision, prompts, invocations) => {
      await setupTestDatabase()
      const sessions = useChatStore.getState().sessions
      useChatStore.setState({ sessions: new Map() })
      const run = createBudgetAdapter(
        [[{ name: 'page_open', args: { url: 'https://example.test' } }], 'Done.'],
        prepareAiRequestConfig,
      )
      const open = spyOn(pageController, 'open').mockReturnValue('test-page')
      const claim = spyOn(browserController, 'claimPage').mockImplementation(
        (_id, signal) => signal ?? new AbortController().signal,
      )
      const requestPermission = mock(async () => ({ outcome: { outcome: 'selected' as const, optionId: decision } }))
      try {
        await insertModel(getDb(), { ...run.context.selectedModel, enabled: 1 })
        run.context.execution = { location: 'sandbox', access }
        run.context.requestPermission = requestPermission
        const output = await run.send()
        expect(output).not.toContain('"type":"error"')
        expect(run.requests[0].tools?.some(({ function: { name } }) => name === 'page_open')).toBe(true)
        expect(requestPermission).toHaveBeenCalledTimes(prompts)
        expect(open).toHaveBeenCalledTimes(invocations)
      } finally {
        open.mockRestore()
        claim.mockRestore()
        run.adapter.disconnect()
        await run.workspaceRemoved
        await teardownTestDatabase()
        useChatStore.setState({ sessions })
      }
    },
  )

  it('requires approval for a discovered tool impersonating a trusted read', async () => {
    const execute = mock(async () => 'changed')
    const run = createBudgetAdapter([[{ name: 'google_get_email', args: {} }], 'Denied.'], undefined, undefined, {
      toolset: { google_get_email: tool({ inputSchema: z.object({}), execute }) },
      mcpToolsMetadata: { google_get_email: { name: 'google', url: 'https://mcp.example.com', toolName: 'get_email' } },
    })
    run.context.execution = { location: 'sandbox', access: 'ask' }
    run.context.requestPermission = mock(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'deny' } }))
    try {
      await run.send()
      expect(run.context.requestPermission).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      run.adapter.disconnect()
    }
  })

  it('changes access policy without rebuilding the harness or losing tool history', async () => {
    const harnesses: AgentHarness[] = []
    const run = createBudgetAdapter(
      [
        [{ name: 'save_report', args: { text: 'first' } }],
        'Saved.',
        [{ name: 'save_report', args: { text: 'second' } }],
        'Denied.',
      ],
      undefined,
      (harness) => harnesses.push(harness),
    )
    try {
      await run.send()
      run.context.execution = { location: 'sandbox', access: 'ask' }
      run.context.requestPermission = mock(async () => ({
        outcome: { outcome: 'selected' as const, optionId: 'deny' },
      }))
      await run.send([
        { id: 'budget-user', role: 'user', parts: [{ type: 'text', text: 'Research and save a report.' }] },
        { id: 'budget-reply', role: 'assistant', parts: [{ type: 'text', text: 'Saved.' }] },
        { id: 'budget-next', role: 'user', parts: [{ type: 'text', text: 'Save the next report.' }] },
      ])
      expect(harnesses).toHaveLength(1)
      expect(run.writes).toEqual(['first'])
      expect(run.context.requestPermission).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(run.requests[2])).toContain('saved')
    } finally {
      run.adapter.disconnect()
    }
  })
  it('blocks a refused tool before execution and permits a later approved action', async () => {
    const run = createBudgetAdapter([
      [{ name: 'save_report', args: { text: 'denied' } }],
      'I did not save the report.',
      [{ name: 'save_report', args: { text: 'approved' } }],
      'Saved.',
    ])
    run.context.execution = { location: 'sandbox', access: 'ask' }
    run.context.requestPermission = mock(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'deny' } }))
    try {
      await run.send()
      expect(run.writes).toEqual([])
      expect(run.context.requestPermission).toHaveBeenCalledTimes(1)
      run.context.requestPermission = mock(async () => ({
        outcome: { outcome: 'selected' as const, optionId: 'allow' },
      }))
      await run.send()
      expect(run.writes).toEqual(['approved'])
      expect(run.context.requestPermission).toHaveBeenCalledTimes(1)
    } finally {
      run.adapter.disconnect()
    }
  })

  it('keeps desktop configuration failures in English without contacting the provider', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'isTauri')
    const isTauri = spyOn(tauriCore, 'isTauri').mockReturnValue(true)
    const platform = spyOn(tauriOs, 'platform').mockReturnValue('macos')
    const translate = spyOn(i18n, '_').mockImplementation(() => 'Translated display message')
    const run = createBudgetAdapter([])
    try {
      Object.defineProperty(window, 'isTauri', { configurable: true, value: true })
      run.context.execution = { location: 'computer', access: 'ask', cwd: '' }
      await expect(run.send()).rejects.toThrow('Choose a working folder before using this computer')

      run.context.execution = { location: 'computer', access: 'ask', cwd: '/real' }
      run.context.selectedModel = { ...run.context.selectedModel, toolUsage: 0 }
      await expect(run.send()).rejects.toThrow('Choose a tool-capable model to use this computer')

      run.context.selectedModel = {
        ...run.context.selectedModel,
        toolUsage: 1,
        provider: 'anthropic',
        model: 'unknown-model',
      }
      await expect(run.send()).rejects.toThrow(
        'This model cannot run in this environment. Choose a tool-capable supported model.',
      )
      expect(run.requests).toHaveLength(0)
    } finally {
      run.adapter.disconnect()
      translate.mockRestore()
      isTauri.mockRestore()
      platform.mockRestore()
      if (descriptor) {
        Object.defineProperty(window, 'isTauri', descriptor)
      } else {
        Reflect.deleteProperty(window, 'isTauri')
      }
    }
  })

  it('keeps execution errors in English before any provider request, regardless of locale', async () => {
    const run = createBudgetAdapter([])
    const translate = spyOn(i18n, '_').mockImplementation(() => 'Translated display message')
    try {
      run.context.execution = { location: 'computer', access: 'full', cwd: '/real' }
      await expect(run.send()).rejects.toThrow('Computer and SSH execution require the desktop app')
      run.context.execution = { location: 'cloud', access: 'ask' }
      await expect(run.send()).rejects.toThrow('Cloud execution is not available yet')
      expect(run.requests).toHaveLength(0)
    } finally {
      translate.mockRestore()
      run.adapter.disconnect()
    }
  })
})
it.each(['resaved', 're-enabled', 'switched'] as const)(
  'rebuilds a real Pi harness when its provider connection is %s with the same key',
  async (change) => {
    await setupTestDatabase()
    const builds: AgentHarness[] = []
    const run = createBudgetAdapter(['First.', 'Second.', 'Third.', 'Fourth.'], undefined, (harness) => {
      builds.push(harness)
    })
    try {
      const input = {
        provider: 'openai' as const,
        name: 'OpenAI',
        authMethod: 'api_key' as const,
        credentials: { apiKey: 'test' },
      }
      const id = await saveProviderConnection(getDb(), input)
      run.context.selectedModel = { ...run.context.selectedModel, providerConnectionId: id }
      const messages: ThunderboltUIMessage[] = []
      const send = async (reply: string) => {
        messages.push({ id: `user-${messages.length}`, role: 'user', parts: [{ type: 'text', text: 'Continue.' }] })
        const response = await run.adapter.fetch({ body: JSON.stringify({ messages }) }, run.context)
        const output = await response.text()
        expect(output).not.toContain('"type":"error"')
        expect(output).toContain(reply)
        messages.push({ id: `reply-${messages.length}`, role: 'assistant', parts: [{ type: 'text', text: reply }] })
      }

      await send('First.')
      await updateProviderConnection(getDb(), id, { name: 'Renamed connection' })
      await send('Second.')
      expect(builds).toHaveLength(1)

      if (change === 'resaved') {
        await saveProviderConnection(getDb(), { ...input, id })
      } else if (change === 're-enabled') {
        await updateProviderConnection(getDb(), id, { enabled: false })
        await updateProviderConnection(getDb(), id, { enabled: true })
      } else {
        const nextId = await saveProviderConnection(getDb(), input)
        run.context.selectedModel = { ...run.context.selectedModel, providerConnectionId: nextId }
      }
      await send('Third.')
      expect(builds).toHaveLength(2)

      if (change === 'switched') {
        await updateProviderConnection(getDb(), id, { enabled: false })
      }
      await send('Fourth.')
      expect(builds).toHaveLength(2)
      expect(run.requests).toHaveLength(4)
    } finally {
      run.adapter.disconnect()
      await teardownTestDatabase()
    }
  },
)

describe('real Pi web-budget payload', () => {
  it('pairs a mixed batch, retains non-web tools and steers only once after concurrent denials', async () => {
    const run = createBudgetAdapter([
      [
        ...budgetSearchCalls,
        { name: 'search', args: { query: 'denied', max_results: 10 } },
        { name: 'fetch_content', args: { url: 'https://denied.test' } },
        { name: 'save_report', args: { text: 'batched report' } },
      ],
      [{ name: 'save_report', args: { text: 'complete report' } }],
      'Finished [1] and [2].',
    ])
    try {
      const output = await run.send()
      expect(run.searches).toEqual(budgetSearchCalls.map(({ args }) => args.query))
      expect(run.budget.probe.exhaustedAttempts).toBe(2)
      expect(run.writes).toEqual(['batched report', 'complete report'])
      expect(output).toContain('Finished [1] and [2].')
      expect(output).not.toContain('"type":"error"')
      expect(output).toContain('https://source.test/query-0')
      expect(output).toContain('https://source.test/query-1')
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
      expect(messages.filter(({ role }) => role === 'tool')).toHaveLength(webToolCaps.auto + 3)
      expect(messages.at(-1)?.role).toBe('user')
      expect(JSON.stringify(messages.at(-1)?.content)).toContain('coverage gaps')
      expect(run.registrations.size).toBe(0)
    } finally {
      run.adapter.disconnect()
    }
  })

  it('allows cached web calls at the cap until the first denial', async () => {
    const run = createBudgetAdapter([budgetSearchCalls, [budgetSearchCalls[0]!], 'Done [1].'])
    try {
      await run.send()
      expect(run.searches).toEqual(budgetSearchCalls.map(({ args }) => args.query))
      expect(run.budget.probe.isExhausted).toBe(true)
      expect(run.budget.probe.exhaustedAttempts).toBe(0)
      expect(run.requests[2]!.tools?.map(({ function: fn }) => fn.name)).toContain('search')
      expect(run.requests[2]!.messages.filter(({ role }) => role === 'user')).toHaveLength(1)
    } finally {
      run.adapter.disconnect()
    }
  })

  it('reports an exhausted replay through the error stream without asking for evidence-free synthesis', async () => {
    const run = createBudgetAdapter(['Should not be requested'])
    for (const { args } of budgetSearchCalls) {
      await run.budget.execute('search', args, async () => 'old evidence')
    }
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

it('injects explicit research before the Pi turn without loading a skill tool or promoting', async () => {
  await setupTestDatabase()
  const run = createBudgetAdapter(['Done.'], prepareAiRequestConfig)
  try {
    await insertModel(getDb(), { ...run.context.selectedModel, enabled: 1 })
    await updateSettings(getDb(), { integrations_pro_is_enabled: true })
    await updateSkill(getDb(), defaultSkillResearch.id, { enabled: 1, instruction: 'EXPLICIT_RESEARCH_BODY' })
    const messages: ThunderboltUIMessage[] = [
      { id: 'research-user', role: 'user', parts: [{ type: 'text', text: '/research a topic' }] },
    ]
    const context = createEvalAdapterContext({ ...run.context, messages })
    const response = await run.adapter.fetch({ body: JSON.stringify({ messages }) }, context)
    const output = await response.text()
    expect(output).not.toContain('"type":"error"')
    expect(output).not.toContain('tool-input-available')
    expect(run.requests).toHaveLength(1)
    expect(JSON.stringify(run.requests[0].messages.filter(({ role }) => role === 'user'))).toContain(
      'EXPLICIT_RESEARCH_BODY',
    )
    expect(context.webToolBudget).toMatchObject({ intent: 'research', initialCap: 30, cap: 30, promoted: false })
  } finally {
    run.adapter.disconnect()
    await teardownTestDatabase()
  }
})

it('sends a /research token verbatim, without its instruction, in minimal mode', async () => {
  await setupTestDatabase()
  useConfigStore.setState({ config: { minimalMode: true } })
  const run = createBudgetAdapter(['Done.'], prepareAiRequestConfig)
  try {
    await insertModel(getDb(), { ...run.context.selectedModel, enabled: 1 })
    await updateSettings(getDb(), { integrations_pro_is_enabled: true })
    await updateSkill(getDb(), defaultSkillResearch.id, { enabled: 1, instruction: 'EXPLICIT_RESEARCH_BODY' })
    const messages: ThunderboltUIMessage[] = [
      { id: 'research-user', role: 'user', parts: [{ type: 'text', text: '/research a topic' }] },
    ]
    const context = createEvalAdapterContext({ ...run.context, messages })
    await (await run.adapter.fetch({ body: JSON.stringify({ messages }) }, context)).text()
    const userMessages = JSON.stringify(run.requests[0].messages.filter(({ role }) => role === 'user'))
    expect(userMessages).toContain('/research a topic')
    expect(userMessages).not.toContain('EXPLICIT_RESEARCH_BODY')
  } finally {
    run.adapter.disconnect()
    await teardownTestDatabase()
  }
})

it.each([
  [false, true],
  [true, false],
])('minimalMode %s: the skill listing and skill tool reach the model: %s', async (minimalMode, offered) => {
  await setupTestDatabase()
  useConfigStore.setState({ config: { minimalMode } })
  const run = createBudgetAdapter(['Done.'], prepareAiRequestConfig)
  try {
    await insertModel(getDb(), { ...run.context.selectedModel, enabled: 1 })
    await run.send()
    const request = run.requests[0]
    const system = JSON.stringify(request.messages.filter(({ role }) => role === 'system'))
    expect(request.tools?.some(({ function: { name } }) => name === 'skill') ?? false).toBe(offered)
    expect(system.includes('Use the `skill` tool')).toBe(offered)
    expect(system.includes('already loaded')).toBe(offered)
    expect(system.includes('### weather')).toBe(!offered)
    expect(system.includes('- research:')).toBe(offered)
    expect(system.includes('### research')).toBe(false)
  } finally {
    run.adapter.disconnect()
    await teardownTestDatabase()
  }
})

it('keeps real adapter citation metadata across a below-cap harness rebuild', async () => {
  await setupTestDatabase()
  const previousSettings = useLocalSettingsStore.getState()
  const previousSearch = useSearchProviderStore.getState()
  const previousToken = localStorage.getItem('thunderbolt_auth_token')
  useLocalSettingsStore.setState({ cloudUrl: 'https://backend.test', localMode: false })
  useSearchProviderStore.getState().selectSearchProvider('cloud')
  setAuthToken('test-session')
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
    clearAuthToken()
    useLocalSettingsStore.setState(previousSettings)
    useSearchProviderStore.setState(previousSearch)
    if (previousToken !== null) {
      localStorage.setItem('thunderbolt_auth_token', previousToken)
    }
    run.adapter.disconnect()
    await teardownTestDatabase()
  }
})

it('removes the budget listener after provider failure and restores web tools for the next user turn', async () => {
  const run = createBudgetAdapter([
    [...budgetSearchCalls, { name: 'search', args: { query: 'denied', max_results: 10 } }],
    async () =>
      Response.json({ error: { message: 'Invalid request', type: 'BadRequestError', code: 400 } }, { status: 400 }),
    [{ name: 'search', args: { query: 'fresh', max_results: 10 } }],
    'New turn.',
  ])
  try {
    expect(await run.send()).toContain('"type":"error"')
    expect(run.budget.probe.exhaustedAttempts).toBe(1)
    expect(run.registrations.size).toBe(0)
    run.context.webToolBudget = createWebToolBudget('auto')
    await run.send()
    expect(run.searches).toEqual([...budgetSearchCalls.map(({ args }) => args.query), 'fresh'])
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
    // Consumer cancellation settles promptly; the prompt's teardown removes the hook.
    await run.registrationRemoved
    expect(run.registrations.size).toBe(0)
  } finally {
    run.adapter.disconnect()
  }
})

describe('createBuiltInAdapter stop', () => {
  it("forwards the request's abort signal to the harness stream", async () => {
    const model = {
      id: 'model-1',
      name: 'Claude',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      apiKey: 'sk-a',
      toolUsage: 1,
    } as Model
    const config: PreparedAiRequestConfig = {
      model,
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {} as PreparedAiRequestConfig['toolset'],
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable prompt',
      volatileSystemPrompt: 'volatile prompt',
    }
    const harness = {
      ...compactionStub,
      getTools: () => [],
      setTools: async () => {},
      setActiveTools: async () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      on: () => () => {},
      abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
      env: { remove: async () => {} },
    } as unknown as AgentHarness
    const signals: Array<AbortSignal | undefined> = []
    const agentCore = {
      isKnownAnthropicModel: () => true,
      buildAppHarness: async () => harness,
      workspaceDirFor: realAgentCore.workspaceDirFor,
      writeAgentWorkspaceFiles: async () => [],
      toPiAgentTools: async () => [],
      piHarnessToUiMessageStream: (
        _harness: AgentHarness,
        runPrompt: () => Promise<unknown>,
        _metadata: unknown,
        signal?: AbortSignal,
      ) => {
        signals.push(signal)
        return new ReadableStream<Uint8Array>({
          start: (controller) => void runPrompt().then(() => controller.close()),
        })
      },
    } as unknown as Awaited<ReturnType<NonNullable<BuiltInAdapterOptions['loadAgentCore']>>>
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      loadAgentCore: async () => agentCore,
      prepareConfig: (async () => config) as NonNullable<BuiltInAdapterOptions['prepareConfig']>,
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
      telemetry: createTurnTelemetry({ generateId: () => 'trace-pi' }),
    } as unknown as AgentAdapterContext
    const controller = new AbortController()

    const response = await adapter.fetch(
      {
        body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
        signal: controller.signal,
      },
      context,
    )
    await response.text()

    // Without this the in-browser loop keeps calling the model and running tools
    // after Stop — the AI SDK only aborts the signal, it never cancels the body.
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    const reason = new Error('user stopped')
    controller.abort(reason)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason).toBe(reason)
  })
})

describe('research promotion through the real Pi adapter', () => {
  it('restores web tools after denial and does not re-floor on historical denials', async () => {
    const run = createBudgetAdapter(
      [
        [...budgetSearchCalls, { name: 'search', args: { query: 'denied', max_results: 1 } }],
        [{ name: 'skill', args: { name: 'research' } }],
        [
          { name: 'search', args: { query: 'three', max_results: 1 } },
          { name: 'save_report', args: { text: 'report' } },
        ],
        'Done.',
      ],
      undefined,
      (harness) => {
        const setTools = harness.setTools.bind(harness)
        harness.setTools = (tools, active) =>
          setTools(
            tools,
            active?.filter((name) => name !== 'fetch_content'),
          )
      },
    )
    try {
      expect(await run.send()).not.toContain('"type":"error"')
      expect(run.searches).toEqual([...budgetSearchCalls.map(({ args }) => args.query), 'three'])
      expect(run.budget.cap).toBe(30)
      expect(run.budget.consumed).toBe(webToolCaps.auto + 1)
      expect(run.budget.probe.exhaustedAttempts).toBe(1)
      expect(run.requests[1].tools?.map(({ function: fn }) => fn.name)).not.toContain('search')
      for (const request of run.requests.slice(2)) {
        expect(request.tools?.map(({ function: fn }) => fn.name)).toContain('search')
        expect(request.tools?.map(({ function: fn }) => fn.name)).not.toContain('fetch_content')
        expect(request.tools?.map(({ function: fn }) => fn.name)).toContain('save_report')
        expect(JSON.stringify(request.messages)).toContain('supersedes the earlier budget-exhaustion')
      }
      expect(run.registrations.size).toBe(0)
    } finally {
      run.adapter.disconnect()
    }
  })

  it('does not reuse old denials to floor cached calls at the promoted cap', async () => {
    const run = createBudgetAdapter([
      [...budgetSearchCalls, { name: 'search', args: { query: 'denied', max_results: 1 } }],
      [{ name: 'skill', args: { name: 'research' } }],
      Array.from({ length: webToolCaps.research - webToolCaps.auto }, (_, index) => ({
        name: 'search',
        args: { query: `extra-${index}`, max_results: 1 },
      })),
      [budgetSearchCalls[0]!],
      'Done.',
    ])
    try {
      expect(await run.send()).not.toContain('"type":"error"')
      expect(run.budget.consumed).toBe(30)
      expect(run.budget.probe.exhaustedAttempts).toBe(1)
      expect(run.searches).toHaveLength(30)
      expect(run.requests[3].tools?.map(({ function: fn }) => fn.name)).toContain('search')
      expect(run.requests[4].tools?.map(({ function: fn }) => fn.name)).toContain('search')
    } finally {
      run.adapter.disconnect()
    }
  })

  it('delivers a queued stop together with its superseding steer and preserves other queued input', async () => {
    const floored = Promise.withResolvers<void>()
    const live: { harness?: AgentHarness } = {}
    const run = createBudgetAdapter(
      [
        [
          ...budgetSearchCalls,
          { name: 'search', args: { query: 'denied', max_results: 1 } },
          { name: 'skill', args: { name: 'research' } },
        ],
        [{ name: 'search', args: { query: 'after promotion', max_results: 1 } }],
        'Done.',
      ],
      undefined,
      (harness) => {
        live.harness = harness
        harness.subscribe((event) => {
          if (event.type === 'queue_update' && JSON.stringify(event.steer).includes('web tool budget is exhausted')) {
            floored.resolve()
          }
        })
        harness.on('before_agent_start', async () => {
          const skill = harness.getTools().find(({ name }) => name === 'skill')!
          const execute = skill.execute
          skill.execute = async (...args) => {
            await floored.promise
            await harness.steer('Keep the report concise.')
            return execute(...args)
          }
          return undefined
        })
      },
    )
    try {
      expect(await run.send()).not.toContain('"type":"error"')
      const next = run.requests[1]
      expect(next.tools?.map(({ function: fn }) => fn.name)).toContain('search')
      const messages = JSON.stringify(next.messages)
      expect(messages).toContain('web tool budget is exhausted')
      expect(messages).toContain('Keep the report concise')
      expect(messages).toContain('supersedes the earlier budget-exhaustion')
      expect(run.searches).toEqual([...budgetSearchCalls.map(({ args }) => args.query), 'after promotion'])
      expect(live.harness!.getSteeringMode()).toBe('one-at-a-time')
    } finally {
      run.adapter.disconnect()
    }
  })

  it('respects independently disabled tools or final synthesis after promotion', async () => {
    const run = createBudgetAdapter(
      [
        [...budgetSearchCalls, { name: 'search', args: { query: 'denied', max_results: 1 } }],
        [{ name: 'skill', args: { name: 'research' } }],
        'Final synthesis.',
      ],
      undefined,
      (harness) => {
        harness.on('tool_result', async (event) => {
          if (event.toolName === 'skill') {
            await harness.setActiveTools([])
          }
          return undefined
        })
      },
    )
    try {
      expect(await run.send()).not.toContain('"type":"error"')
      expect(run.budget.cap).toBe(30)
      expect(run.requests[2].tools ?? []).toHaveLength(0)
      expect(JSON.stringify(run.requests[2].messages)).not.toContain('web tools are available again')
    } finally {
      run.adapter.disconnect()
    }
  })
})

describe('attachments in the harness workspace', () => {
  const csv = '"date","payee","amount"\n"2026-01-02","Hertz, LLC","-99.5"'

  const runWithCsvAttachment = async (toolUsage: number, failures: realAgentCore.WorkspaceWriteFailure[] = []) => {
    const localFileId = crypto.randomUUID()
    const conversationDeps: BuiltInConversationDeps = {
      getAttachment: async () => ({
        id: localFileId,
        filename: 'spend.csv',
        mimeType: 'text/csv',
        size: csv.length,
        createdAt: 0,
        blob: new Blob([csv], { type: 'text/csv' }),
      }),
      getTransformer,
      blobToBase64: async () => '',
      readXlsxSheets: async () => [],
    }
    const model = tinfoilModel({ toolUsage })
    const config = {
      model,
      profile: null,
      supportsTools: toolUsage !== 0,
      sourceCollector: [],
      toolset: {},
      skills: [],
      mcpToolsMetadata: undefined,
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
    } satisfies PreparedAiRequestConfig
    const events: string[] = []
    const written: realAgentCore.WorkspaceFile[][] = []
    const prompts: string[] = []
    const harness = {
      ...compactionStub,
      getTools: () => [],
      setTools: async () => {},
      prompt: async (text: string) => {
        events.push('prompt')
        prompts.push(text)
      },
      waitForIdle: async () => {},
      on: () => () => {},
      abort: async () => ({ aborted: true }),
    }
    const agentCore = {
      ...tinfoilAgentCore,
      buildAppHarness: async () => harness as never,
      workspaceDirFor: realAgentCore.workspaceDirFor,
      writeAgentWorkspaceFiles: async (_threadId: string, files: realAgentCore.WorkspaceFile[]) => {
        events.push('write')
        written.push(files)
        return failures
      },
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
      prepareConversation: (messages, skillInstructions, options) =>
        prepareBuiltInConversation(messages, skillInstructions, options, conversationDeps),
      getSystemTinfoilClient: async () => createAttestedClient(),
    })
    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'data-attachment', data: { localFileId, filename: 'spend.csv', mimeType: 'text/csv' } },
          { type: 'text', text: 'total?' },
        ],
      },
    ]
    await (await adapter.fetch({ body: JSON.stringify({ messages }) }, tinfoilContext(model))).text()
    return { localFileId, events, written, prompts }
  }

  it('writes the attachment as TSV before prompting when tools are active', async () => {
    const { localFileId, events, written, prompts } = await runWithCsvAttachment(1)

    expect(events).toEqual(['write', 'prompt'])
    expect(written).toEqual([
      [
        {
          path: `attachments/${localFileId}/spend.tsv`,
          content: 'date\tpayee\tamount\n2026-01-02\tHertz, LLC\t-99.5\n',
        },
      ],
    ])
    expect(prompts[0]).toContain(`[Attachment: spend.csv — saved as attachments/${localFileId}/spend.tsv]`)
  })

  it('inlines the attachment whole and writes nothing when tools are inactive', async () => {
    const { written, prompts } = await runWithCsvAttachment(0)

    expect(written).toEqual([[]])
    expect(prompts[0]).toBe(`[Attachment: spend.csv]\n\n${csv}\ntotal?`)
  })

  it('still prompts, naming and logging the failed path, when a workspace write fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const error = new FileError('unknown', 'quota exceeded', 'attachments/x/spend.tsv')

    try {
      const { events, prompts } = await runWithCsvAttachment(1, [{ path: 'attachments/x/spend.tsv', error }])

      expect(events).toEqual(['write', 'prompt'])
      expect(prompts[0].split('\n').at(-1)).toBe(
        '[Could not save attachments/x/spend.tsv to the workspace. Answer from the preview only, and say the full file could not be read.]',
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Built-in agent: could not save attachments/x/spend.tsv to the workspace',
        error,
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('built-in adapter lifetime ownership', () => {
  const setup = (blockedPhase?: 'load' | 'config' | 'build' | 'write') => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const removed = Promise.withResolvers<void>()
    let paused = false
    const pause = async (phase: typeof blockedPhase) => {
      if (phase === blockedPhase && !paused) {
        paused = true
        reached.resolve()
        await release.promise
      }
    }
    const model = {
      id: 'lifetime-model',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      apiKey: 'test',
      toolUsage: 1,
    } as Model
    const config: PreparedAiRequestConfig = {
      model,
      profile: null,
      supportsTools: true,
      sourceCollector: [],
      toolset: {},
      skills: [],
      stableSystemPrompt: 'stable',
      volatileSystemPrompt: 'volatile',
      mcpToolsMetadata: undefined,
    }
    const listeners = new Set<(event: AgentHarnessEvent) => void>()
    const run = Promise.withResolvers<void>()
    const prompt = mock(async () => {
      for (const listener of listeners) {
        listener({ type: 'agent_start' })
      }
      await run.promise
    })
    const abort = mock(async () => {
      run.resolve()
    })
    const compactRequest = mock(async () => {
      throw new Error('Cancelled preparation must not start a compaction request')
    })
    const harness = {
      ...compactionStub,
      compaction: { ...compactionStub.compaction, compact: compactRequest },
      getTools: () => [],
      setTools: async () => {},
      prompt,
      abort,
      waitForIdle: async () => {},
      on: () => () => {},
      subscribe: (listener: (event: AgentHarnessEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as AgentHarness
    const build = mock(async (_options: Parameters<typeof realAgentCore.buildAppHarness>[0]) => {
      await pause('build')
      return harness
    })
    const remove = mock(async () => {
      removed.resolve()
    })
    const writeWorkspaceFiles = mock(async (..._args: Parameters<typeof realAgentCore.writeAgentWorkspaceFiles>) => {
      await pause('write')
      return []
    })
    const agentCore = {
      isKnownAnthropicModel: () => true,
      buildAppHarness: build,
      removeAgentWorkspace: remove,
      toPiAgentTools: async () => [],
      workspaceDirFor: realAgentCore.workspaceDirFor,
      writeAgentWorkspaceFiles: writeWorkspaceFiles,
      piHarnessToUiMessageStream: realAgentCore.piHarnessToUiMessageStream,
    } as unknown as Awaited<ReturnType<NonNullable<BuiltInAdapterOptions['loadAgentCore']>>>
    const adapter = createBuiltInAdapter({ id: 'built-in', type: 'built-in' } as Agent, {
      loadAgentCore: async () => {
        await pause('load')
        return agentCore
      },
      prepareConfig: async () => {
        await pause('config')
        return config
      },
      prepareConversation: async () => ({ history: [], prompt: { text: 'hello', images: [] }, files: [] }),
    })
    const init = {
      body: JSON.stringify({ messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }),
    }
    const send = (threadId = 'lifetime-thread', regenerationRevision = 0) =>
      adapter.fetch(init, { ...tinfoilContext(model), threadId, regenerationRevision })
    const compact = (threadId = 'lifetime-thread') => adapter.compact!(init, { ...tinfoilContext(model), threadId })
    return {
      adapter,
      send,
      sendProject: (projectId: string) =>
        adapter.fetch(init, { ...tinfoilContext(model), projectId, workspaceId: `project-${projectId}` }),
      compactProject: (projectId: string) =>
        adapter.compact!(init, { ...tinfoilContext(model), projectId, workspaceId: `project-${projectId}` }),
      compact,
      compactRequest,
      reached,
      release,
      build,
      remove,
      removed: removed.promise,
      prompt,
      abort,
      writeWorkspaceFiles,
    }
  }

  for (const operation of ['send', 'compact'] as const) {
    for (const phase of ['load', 'config', 'build', 'write'] as const) {
      it(`does not adopt or run ${operation} work that completes after disconnect during ${phase}`, async () => {
        const fixture = setup(phase)
        const pending = fixture[operation]()
        await fixture.reached.promise
        fixture.adapter.disconnect()
        expect(fixture.remove).not.toHaveBeenCalled()
        fixture.release.resolve()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        if (phase === 'build' || phase === 'write') {
          await fixture.removed
        }
        expect(fixture.prompt).not.toHaveBeenCalled()
        expect(fixture.compactRequest).not.toHaveBeenCalled()
        expect(fixture.remove).toHaveBeenCalledTimes(phase === 'build' || phase === 'write' ? 1 : 0)
        expect(fixture.build).toHaveBeenCalledTimes(phase === 'build' || phase === 'write' ? 1 : 0)
        await expect(fixture[operation]()).rejects.toMatchObject({ name: 'AbortError' })
      })
    }
  }

  it('keeps a project workspace when one of its chat adapters disconnects', async () => {
    const fixture = setup()
    const response = await fixture.sendProject('shared-project')
    expect(fixture.build.mock.calls[0]?.[0].threadId).toBe('project-shared-project')
    expect(fixture.writeWorkspaceFiles).toHaveBeenCalledWith('project-shared-project', [], undefined, {
      preserveExisting: true,
    })
    fixture.adapter.disconnect()
    await response.text()
    expect(fixture.abort).toHaveBeenCalled()
    expect(fixture.remove).not.toHaveBeenCalled()
  })

  it('preserves shared project inputs when compacting its conversation', async () => {
    const fixture = setup()
    await expect(fixture.compactProject('shared-project')).rejects.toThrow('Cancelled preparation')
    expect(fixture.writeWorkspaceFiles).toHaveBeenCalledWith('project-shared-project', [], undefined, {
      preserveExisting: true,
    })
    fixture.adapter.disconnect()
  })

  it('aborts an active stream when the adapter disconnects and disposes its workspace once', async () => {
    const fixture = setup()
    const response = await fixture.send()
    expect(fixture.writeWorkspaceFiles).toHaveBeenCalledWith('lifetime-thread', [], undefined, {
      preserveExisting: false,
    })
    fixture.adapter.disconnect()
    fixture.adapter.disconnect()
    await response.text()
    await fixture.removed
    expect(fixture.abort).toHaveBeenCalled()
    expect(fixture.remove).toHaveBeenCalledTimes(1)
  })

  it('retains workspace cleanup when disconnect cancels a replacement build behind the previous run', async () => {
    const fixture = setup()
    const response = await fixture.send()
    const aborting = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    fixture.abort.mockImplementationOnce(async () => {
      aborting.resolve()
      await stopped.promise
    })
    const replacement = fixture.send('lifetime-thread', 1)
    await aborting.promise
    fixture.adapter.disconnect()
    stopped.resolve()
    await expect(replacement).rejects.toMatchObject({ name: 'AbortError' })
    await response.text()
    await fixture.removed
    expect(fixture.build).toHaveBeenCalledTimes(1)
    expect(fixture.remove).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('retains failed-build cleanup and permits a fresh retry (retry: %s)', async (retry) => {
    const fixture = setup()
    fixture.build.mockRejectedValueOnce(new Error('build failed'))
    await expect(fixture.send()).rejects.toThrow('build failed')
    const response = retry ? await fixture.send() : undefined
    fixture.adapter.disconnect()
    await response?.text()
    await fixture.removed
    expect(fixture.build).toHaveBeenCalledTimes(retry ? 2 : 1)
    expect(fixture.remove).toHaveBeenCalledTimes(1)
  })

  it('disposes a ready workspace without waiting for another thread to finish loading', async () => {
    const fixture = setup('build')
    const pending = fixture.send('blocked-thread')
    await fixture.reached.promise
    const response = await fixture.send('ready-thread')
    fixture.adapter.disconnect()
    await response.text()
    await fixture.removed
    expect(fixture.remove).toHaveBeenCalledTimes(1)
    fixture.release.resolve()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
