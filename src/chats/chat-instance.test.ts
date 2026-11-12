/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `createAgentRoutingFetch` connection-status tests. Verifies the customFetch
 * factory writes `connectionStatus` transitions into the chat-store around
 * each call to the injected `connectToAgent`.
 */

import { createTurnBudget, maxRequestsPerTurn, type TurnBudget } from '@/ai/retry-budget'
import { webToolCaps } from '@/ai/web-tool-budget'
import { createTurnTelemetry, type TurnTelemetryPayload } from '@/ai/turn-telemetry'
import { browserController } from '@/browser/browser-controller'
import { setDebugTranscriptCaptureEnabled } from '@/debug-transcript/recorder'
import { builtInAgent } from '@/defaults/agents'
import { createAgentUnavailableError } from '@/lib/error-utils'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { Agent, AgentAdapter, AgentAdapterContext } from '@/types/acp'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { ChatInit, ChatOnFinishCallback } from 'ai'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { useChatStore } from './chat-store'
import {
  createAgentRoutingFetch as createRoutingFetch,
  createChatInstance,
  type CreateChatInstanceDeps,
} from './chat-instance'
import { getTurnActivity } from './turn-activity'

/** Keep routing unit tests independent of database model and reasoning settings. */
const createAgentRoutingFetch = (...args: Parameters<typeof createRoutingFetch>) => {
  const [id, saveMessages, httpClient, getProxyFetch, dependencies, state] = args
  return createRoutingFetch(
    id,
    saveMessages,
    httpClient,
    getProxyFetch,
    {
      getAvailableModels: async () => useChatStore.getState().models,
      getChatReasoningEffort: async () => undefined,
      ...dependencies,
    },
    state,
  )
}

const sessionId = 'sess-1'
const testModels = [
  createMockModel({ id: 'm1', model: 'claude-opus', provider: 'anthropic', apiKey: 'secret' }),
  createMockModel({ id: 'm2', model: 'gpt-5', provider: 'openai' }),
]
const httpClient: HttpClient = {} as HttpClient
const isAgentActive = async () => true
const getProxyFetch = (): FetchFn => Object.assign(async () => new Response('ok'), { preconnect: async () => false })

const makeAdapter = (agent: Agent): AgentAdapter => ({
  agent,
  capabilities: null,
  fetch: async () => new Response('ok'),
  ensureSession: async () => {},
  disconnect: () => {},
})

const hydrate = () => {
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: null,
    id: sessionId,
    models: testModels,
    selectedModel: testModels[0],
    triggerData: null,
  })
}

/** Build a chat instance whose retry callbacks and original methods are observable. */
const createRetryHarness = (saveMessages: SaveMessagesFunction = async () => {}) => {
  const regenerate = mock(async () => {})
  const sendMessage = mock(async (_message: ThunderboltUIMessage) => {})
  const budgets: TurnBudget[] = []
  let onFinish: ChatOnFinishCallback<ThunderboltUIMessage> | undefined
  let onError: ((error: Error) => void) | undefined
  let sendAutomaticallyWhen: ChatInit<ThunderboltUIMessage>['sendAutomaticallyWhen']
  const wakeAdapterReconnect = mock(() => {})
  const trackEventImplementation: NonNullable<CreateChatInstanceDeps['trackEvent']> = () => {}
  const trackEvent = mock(trackEventImplementation)

  const createTrackedTurnBudget = () => {
    const budget = createTurnBudget()
    budgets.push(budget)
    return budget
  }

  const createChat = (init: ChatInit<ThunderboltUIMessage>) => {
    onFinish = init.onFinish
    onError = init.onError
    sendAutomaticallyWhen = init.sendAutomaticallyWhen
    return {
      id: init.id ?? sessionId,
      messages: init.messages ?? [],
      status: 'ready',
      regenerate,
      sendMessage,
      stop: mock(() => Promise.resolve()),
    } as never
  }

  const instance = createChatInstance(sessionId, [], saveMessages, httpClient, getProxyFetch, {
    createChat,
    createTurnBudget: createTrackedTurnBudget,
    wakeAdapterReconnect,
    trackEvent,
  })
  hydrateStore({
    chatInstance: instance,
    chatThread: null,
    id: sessionId,
    models: testModels,
    selectedModel: testModels[0],
    triggerData: null,
  })

  const finishWithError = (
    error?: Error,
    message: ThunderboltUIMessage = { id: 'failed-assistant', role: 'assistant', parts: [] },
  ) => {
    if (error) {
      onError?.(error)
    }
    return onFinish!({
      message,
      messages: [],
      isAbort: false,
      isDisconnect: false,
      isError: true,
    })
  }

  const finishSuccessfully = (
    message: ThunderboltUIMessage = {
      id: 'successful-assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Done' }],
    },
  ) =>
    onFinish!({
      message,
      messages: [],
      isAbort: false,
      isDisconnect: false,
      isError: false,
    })

  const finishAborted = () =>
    onFinish!({
      message: {
        id: 'aborted-assistant',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Partial' }],
      },
      messages: [],
      isAbort: true,
      isDisconnect: false,
      isError: false,
    })

  const finishAbortedEmpty = () =>
    onFinish!({
      message: { id: 'aborted-empty', role: 'assistant', parts: [] },
      messages: [],
      isAbort: true,
      isDisconnect: false,
      isError: false,
    })

  const getTurnBudget = () => budgets.at(-1)!

  /** Ask the SDK's auto-send predicate what it would do with the current messages. */
  const wouldAutoSend = () => sendAutomaticallyWhen!({ messages: instance.messages })

  return {
    finishSuccessfully,
    finishAborted,
    finishAbortedEmpty,
    finishWithError,
    getTurnBudget,
    instance,
    regenerate,
    sendMessage,
    trackEvent,
    wakeAdapterReconnect,
    wouldAutoSend,
  }
}

/** Create a save function whose calls can be resumed in any order. */
const createDeferredSaveMessages = () => {
  const resolvers: Array<() => void> = []
  const saveMessages: SaveMessagesFunction = async () => {
    await new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })
  }
  const resolveSave = (index: number) => resolvers[index]!()
  return { resolveSave, saveMessages }
}

/** Observe turn ownership without creating real browser sessions. */
const trackBrowserTurns = () => {
  const active = new Set<string>()
  const start = spyOn(browserController, 'startAgentTurn').mockImplementation((id) => {
    active.add(id)
    return () => {
      active.delete(id)
    }
  })
  return { active, start }
}

/** Fully consume one injected chat-instance turn budget. */
const exhaustTurnBudget = (budget: TurnBudget) => {
  for (let request = 0; request < maxRequestsPerTurn; request++) {
    budget.consumer.tryConsumeRequest()
  }
  return budget
}

describe('createAgentRoutingFetch — connection status', () => {
  beforeEach(() => {
    resetStore()
    hydrate()
  })

  afterEach(() => {
    resetStore()
  })

  it('refreshes access from the database even when the store still has usable credentials', async () => {
    const fetchModel = mock(async () => new Response('ok'))
    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => [],
      getOrConnectAdapter: async () => ({ ...makeAdapter(builtInAgent), fetch: fetchModel }),
    })
    expect(useChatStore.getState().models[0].apiKey).toBe('secret')
    await expect(fetch('https://backend.test', { body: '{}' })).rejects.toThrow(
      'Configure and select an available model',
    )
    expect(fetchModel).not.toHaveBeenCalled()
    expect(useChatStore.getState().models).toEqual([])
  })

  it.each([false, true])('preserves conversation privacy after a fresh model read (new thread: %s)', async (isNew) => {
    const fetchModel = mock(async () => new Response('ok'))
    const thread = createMockChatThread({ isEncrypted: 0 })
    if (!isNew) {
      useChatStore.getState().updateSession(sessionId, { chatThread: thread })
    }
    const save = async () => {
      useChatStore.getState().updateSession(sessionId, { chatThread: thread })
    }
    const fetch = createAgentRoutingFetch(sessionId, save, httpClient, getProxyFetch, {
      getAvailableModels: async () => [{ ...testModels[0], isConfidential: 1 }],
      getOrConnectAdapter: async () => ({ ...makeAdapter(builtInAgent), fetch: fetchModel }),
    })
    await expect(fetch('https://backend.test', { body: '{}' })).rejects.toThrow('privacy setting')
    expect(fetchModel).not.toHaveBeenCalled()
  })

  it('rechecks model access after awaiting the adapter before sending credentials', async () => {
    const connected = Promise.withResolvers<AgentAdapter>()
    const fetchModel = mock(async () => new Response('ok'))
    const connecting = Promise.withResolvers<void>()
    const connect = mock(() => {
      connecting.resolve()
      return connected.promise
    })
    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      getOrConnectAdapter: connect,
    })
    const request = fetch('https://backend.test', { body: '{}' })
    await connecting.promise
    expect(connect).toHaveBeenCalledTimes(1)
    useChatStore.getState().setModels([])
    connected.resolve({ ...makeAdapter(builtInAgent), fetch: fetchModel })
    await expect(request).rejects.toThrow('Configure and select an available model')
    expect(fetchModel).not.toHaveBeenCalled()
  })

  it.each(['prompt', 'compact'] as const)('rechecks model access after resolving effort for %s', async (operation) => {
    const effort = Promise.withResolvers<'high'>()
    const resolving = Promise.withResolvers<void>()
    const fetchModel = mock(async () => new Response('ok'))
    const compactModel = mock(async () => ({
      version: 1 as const,
      summary: 'Summary',
      tokensBefore: 100,
      contextTokens: 10,
      retainedTail: [],
    }))
    const route = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getChatReasoningEffort: () => {
        resolving.resolve()
        return effort.promise
      },
      getOrConnectAdapter: async () => ({ ...makeAdapter(builtInAgent), fetch: fetchModel, compact: compactModel }),
    })
    const request =
      operation === 'prompt'
        ? route('https://backend.test', { body: '{}' })
        : route.compact([], undefined, new AbortController().signal)
    await resolving.promise
    useChatStore.getState().setModels([])
    effort.resolve('high')
    await expect(request).rejects.toThrow('Configure and select an available model')
    expect(fetchModel).not.toHaveBeenCalled()
    expect(compactModel).not.toHaveBeenCalled()
  })

  it('uses refreshed credentials if the model changes while connecting', async () => {
    const connected = Promise.withResolvers<AgentAdapter>()
    const seenKeys: Array<string | null | undefined> = []
    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      getOrConnectAdapter: () => connected.promise,
    })
    const request = fetch('https://backend.test', { body: '{}' })
    await Promise.resolve()
    useChatStore.getState().setModels([{ ...testModels[0], apiKey: 'rotated' }])
    connected.resolve({
      ...makeAdapter(builtInAgent),
      fetch: async (_init, context) => {
        seenKeys.push(context.selectedModel.apiKey)
        return new Response('ok')
      },
    })
    await request
    expect(seenKeys).toEqual(['rotated'])
  })

  it.each(['prompt', 'compact'] as const)(
    'uses the logical turn model for prompts and the currently selected model for compaction: %s',
    async (operation) => {
      useChatStore.getState().updateSession(sessionId, { selectedModel: testModels[1] })
      const seen: AgentAdapterContext[] = []
      const route = createAgentRoutingFetch(
        sessionId,
        async () => {},
        httpClient,
        getProxyFetch,
        {
          getOrConnectAdapter: async () => ({
            ...makeAdapter(builtInAgent),
            fetch: async (_init, context) => {
              seen.push(context)
              return new Response('ok')
            },
            compact: async (_init, context) => {
              seen.push(context)
              return { version: 1, summary: 'Summary', tokensBefore: 100, contextTokens: 10, retainedTail: [] }
            },
          }),
        },
        { getTurnModel: () => testModels[0] },
      )
      if (operation === 'prompt') {
        await route('https://backend.test', { body: '{}' })
      } else {
        await route.compact([], undefined, new AbortController().signal)
      }
      expect(seen).toHaveLength(1)
      expect(seen[0].selectedModel.id).toBe(operation === 'prompt' ? 'm1' : 'm2')
    },
  )

  it.each(['prompt', 'compact'] as const)('rechecks access after reasoning discovery before %s', async (operation) => {
    const discovering = Promise.withResolvers<void>()
    const effort = Promise.withResolvers<undefined>()
    const fetch = mock(async () => new Response('ok'))
    const compact = mock(async () => ({
      version: 1 as const,
      summary: 'Summary',
      tokensBefore: 100,
      contextTokens: 10,
      retainedTail: [],
    }))
    const route = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      getChatReasoningEffort: async () => {
        discovering.resolve()
        return effort.promise
      },
      getOrConnectAdapter: async () => ({ ...makeAdapter(builtInAgent), fetch, compact }),
    })
    const request =
      operation === 'prompt'
        ? route('https://backend.test', { body: '{}' })
        : route.compact([], undefined, new AbortController().signal)
    await discovering.promise
    useChatStore.getState().setModels([])
    effort.resolve(undefined)
    await expect(request).rejects.toThrow('Configure and select an available model')
    expect(fetch).not.toHaveBeenCalled()
    expect(compact).not.toHaveBeenCalled()
  })

  it('passes the newly persisted thread and ACP session to the adapter', async () => {
    const thread = createMockChatThread({ isEncrypted: 0, acpSessionId: 'persisted-acp' })
    const contexts: AgentAdapterContext[] = []
    const fetch = createAgentRoutingFetch(
      sessionId,
      async () => {
        useChatStore.getState().updateSession(sessionId, { chatThread: thread })
      },
      httpClient,
      getProxyFetch,
      {
        getAvailableModels: async () => useChatStore.getState().models,
        getOrConnectAdapter: async () => ({
          ...makeAdapter(builtInAgent),
          fetch: async (_init, context) => {
            contexts.push(context)
            return new Response('ok')
          },
        }),
      },
    )
    await fetch('https://backend.test', { body: '{}' })
    expect(contexts[0].chatThread).toBe(thread)
    expect(contexts[0].acpSessionId).toBe('persisted-acp')
  })

  it('routes a remote agent without requiring any local models', async () => {
    const remote: Agent = { ...builtInAgent, id: 'remote', type: 'remote-acp', transport: 'websocket' }
    useChatStore.getState().updateSession(sessionId, { selectedAgent: remote })
    useChatStore.getState().setModels([])
    const fetchModel = mock(async () => new Response('ok'))
    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      getOrConnectAdapter: async () => ({ ...makeAdapter(remote), fetch: fetchModel }),
      isAgentActive,
    })
    await fetch('https://backend.test', { body: '{}' })
    expect(fetchModel).toHaveBeenCalledTimes(1)
  })

  it.each(['prompt', 'compact'] as const)('resolves the saved effort before routing %s', async (operation) => {
    const effort = Promise.withResolvers<'high'>()
    const effortRequested = Promise.withResolvers<void>()
    const getChatReasoningEffort = mock(() => {
      effortRequested.resolve()
      return effort.promise
    })
    const seen: AgentAdapterContext[] = []
    const adapter: AgentAdapter = {
      ...makeAdapter(builtInAgent),
      fetch: async (_init, context) => {
        seen.push(context)
        return new Response('ok')
      },
      compact: async (_init, context) => {
        seen.push(context)
        return { version: 1, summary: 'Summary', tokensBefore: 100, contextTokens: 10, retainedTail: [] }
      },
    }
    const route = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      isAgentActive,
      getChatReasoningEffort,
      getOrConnectAdapter: async () => adapter,
    })
    const request =
      operation === 'prompt'
        ? route('https://backend.test', { body: JSON.stringify({ messages: [] }) })
        : route.compact([], undefined, new AbortController().signal)
    await effortRequested.promise
    expect(getChatReasoningEffort).toHaveBeenCalledWith(sessionId, expect.objectContaining({ id: 'm1' }))
    expect(seen).toHaveLength(0)
    effort.resolve('high')
    await request
    expect(getChatReasoningEffort).toHaveBeenCalledWith(sessionId, expect.objectContaining({ id: 'm1' }))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.reasoningEffort).toBe('high')
  })

  it('does not send with stale effort when its pending settings write fails', async () => {
    const write = Promise.withResolvers<never>()
    const connect = mock(async () => makeAdapter(builtInAgent))
    const resolveEffort = mock(() => write.promise)
    const save = mock(async () => {})
    const route = createAgentRoutingFetch(sessionId, save, httpClient, getProxyFetch, {
      isAgentActive,
      getChatReasoningEffort: resolveEffort,
      getOrConnectAdapter: connect,
    })
    const request = route('https://backend.test', { body: JSON.stringify({ messages: [] }) })
    write.reject(new Error('Settings write failed'))
    await expect(request).rejects.toThrow('Settings write failed')
    expect(resolveEffort).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('leaves effort resolution to remote agents', async () => {
    const agent: Agent = {
      ...builtInAgent,
      id: 'remote',
      type: 'remote-acp',
      transport: 'websocket',
      url: 'wss://agent.test',
    }
    useChatStore.getState().updateSession(sessionId, { selectedAgent: agent })
    const resolveEffort = mock(async () => 'high' as const)
    const adapter: AgentAdapter = {
      ...makeAdapter(agent),
      fetch: async (_init, context) => {
        expect(context.reasoningEffort).toBeUndefined()
        return new Response('ok')
      },
    }
    const route = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      isAgentActive,
      getChatReasoningEffort: resolveEffort,
      getOrConnectAdapter: async () => adapter,
    })
    await route('https://backend.test', { body: JSON.stringify({ messages: [] }) })
    expect(resolveEffort).not.toHaveBeenCalled()
  })

  it.each([
    ['/research latest', 'research', 30],
    ['/search latest', 'search', 12],
    ['An ordinary question', 'auto', 5],
  ] as const)('sets the turn budget and preserves exhaustion guidance for %s', async (text, intent, cap) => {
    const adapter: AgentAdapter = {
      ...makeAdapter(builtInAgent),
      fetch: async (_init, context) => {
        const budget = context.webToolBudget!
        for (let call = 0; call < cap; call++) {
          await budget.execute('search', { query: String(call) }, async () => call)
        }
        const denial = await budget.execute('search', { query: 'denied' }, async () => 'must not execute')
        return Response.json({
          intent: budget.intent,
          initialCap: budget.initialCap,
          cap: budget.cap,
          promoted: budget.promoted,
          denial,
        })
      },
    }
    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      isAgentActive,
      getChatReasoningEffort: async () => undefined,
      getOrConnectAdapter: async () => adapter,
    })
    const response = await fetch('https://backend.test', {
      body: JSON.stringify({ messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text }] }] }),
    })
    expect(await response.json()).toEqual({
      intent,
      initialCap: cap,
      cap,
      promoted: false,
      denial: {
        status: 'budget_exhausted',
        message:
          'Per-turn web tool budget reached. Answer now from the results already gathered. If coverage is insufficient, tell the user they can ask you to search more or use /research.',
      },
    })
  })

  it.each([
    [false, ['WEATHER_BODY']],
    [true, []],
  ])(
    'resolves a /weather token for a non-built-in agent only outside minimal mode (%s)',
    async (minimalMode, expected) => {
      useConfigStore.setState({ config: { minimalMode } })
      const remote: Agent = { ...builtInAgent, id: 'remote', type: 'managed-http' }
      useChatStore.getState().updateSession(sessionId, { selectedAgent: remote })
      const seen: Array<string[] | undefined> = []
      const adapter: AgentAdapter = {
        ...makeAdapter(remote),
        fetch: async (_init, context) => {
          seen.push(context.skillInstructions)
          return new Response('ok')
        },
      }
      const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
        getAvailableModels: async () => useChatStore.getState().models,
        isAgentActive,
        getChatReasoningEffort: async () => undefined,
        getOrConnectAdapter: async () => adapter,
        getAllSkills: (async () => [{ name: 'weather', instruction: 'WEATHER_BODY', enabled: 1 }]) as never,
        getDb: (() => ({})) as never,
      })
      await fetch('https://x', {
        body: JSON.stringify({
          messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '/weather today' }] }],
        }),
      })
      expect(seen[0] ?? []).toEqual(expected)
    },
  )

  it('transitions connecting → ready when connectToAgent resolves', async () => {
    const observed: string[] = []
    const connectToAgent = mock(async (agent: Agent) => {
      observed.push(useChatStore.getState().sessions.get(sessionId)!.connectionStatus)
      return makeAdapter(agent)
    })

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      isAgentActive,
      getChatReasoningEffort: async () => undefined,
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('https://x', { body: '{}' } as RequestInit)

    expect(observed).toEqual(['connecting'])
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionStatus).toBe('ready')
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionError).toBeNull()
  })

  it('transitions connecting → error when connectToAgent throws', async () => {
    const connectToAgent = mock(async () => {
      throw new Error('boom')
    })

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      isAgentActive,
      getChatReasoningEffort: async () => undefined,
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await expect(fetch('https://x', { body: '{}' } as RequestInit)).rejects.toThrow('boom')

    const session = useChatStore.getState().sessions.get(sessionId)!
    expect(session.connectionStatus).toBe('error')
    expect(session.connectionError?.message).toBe('boom')
  })

  it('only re-connects when the agent identity changes (cache hit stays ready)', async () => {
    const connectToAgent = mock(async (agent: Agent) => makeAdapter(agent))

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      isAgentActive,
      getChatReasoningEffort: async () => undefined,
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('https://x', { body: '{}' } as RequestInit)
    await fetch('https://x', { body: '{}' } as RequestInit)

    expect(connectToAgent).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionStatus).toBe('ready')
  })

  it('re-enters connecting when agent identity changes between calls', async () => {
    const altAgent: Agent = { ...builtInAgent, id: 'alt' }
    const connectToAgent = mock(async (agent: Agent) => makeAdapter(agent))

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      getAvailableModels: async () => useChatStore.getState().models,
      isAgentActive,
      getChatReasoningEffort: async () => undefined,
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('https://x', { body: '{}' } as RequestInit)
    useChatStore.getState().updateSession(sessionId, { selectedAgent: altAgent })
    await fetch('https://x', { body: '{}' } as RequestInit)

    expect(connectToAgent).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionStatus).toBe('ready')
  })

  it('throws TurnBudgetExhaustedError before invoking the adapter when the consumer is drained', async () => {
    const budget = exhaustTurnBudget(createTurnBudget())
    const adapterFetch = mock(async () => new Response('ok'))
    const connectToAgent = mock(async (agent: Agent) => ({
      ...makeAdapter(agent),
      fetch: adapterFetch,
    }))
    const fetch = createAgentRoutingFetch(
      sessionId,
      async () => {},
      httpClient,
      getProxyFetch,
      {
        getAvailableModels: async () => useChatStore.getState().models,
        isAgentActive,
        getChatReasoningEffort: async () => undefined,
        connectToAgent: connectToAgent as never,
        updateChatThread: (async () => {}) as never,
        getDb: (() => ({})) as never,
      },
      { getTurnBudget: () => budget },
    )

    await expect(fetch('https://x', { body: '{}' } as RequestInit)).rejects.toMatchObject({
      name: 'TurnBudgetExhaustedError',
    })
    expect(adapterFetch).not.toHaveBeenCalled()
  })

  it('marks TTFT only on the first content delta and preserves response metadata', async () => {
    const time = { current: 0 }
    const telemetry = createTurnTelemetry({ now: () => time.current, generateId: () => 'trace-1' })
    const stream = { controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
    const adapterResponse = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          stream.controller = controller
        },
      }),
      {
        status: 206,
        statusText: 'Streaming',
        headers: { 'Content-Type': 'text/event-stream', 'X-Stream-Id': 'stream-1' },
      },
    )
    const adapter = {
      ...makeAdapter(builtInAgent),
      fetch: async () => adapterResponse,
    }
    const fetch = createAgentRoutingFetch(
      sessionId,
      async () => {},
      httpClient,
      getProxyFetch,
      {
        getAvailableModels: async () => useChatStore.getState().models,
        isAgentActive,
        getChatReasoningEffort: async () => undefined,
        getOrConnectAdapter: (async () => adapter) as never,
        updateChatThread: (async () => {}) as never,
        getDb: (() => ({})) as never,
      },
      { getTurnTelemetry: () => telemetry },
    )

    const response = await fetch('https://x', { body: '{}' } as RequestInit)
    const reader = response.body!.getReader()
    const encoder = new TextEncoder()

    expect(response.status).toBe(206)
    expect(response.statusText).toBe('Streaming')
    expect(response.headers.get('X-Stream-Id')).toBe('stream-1')

    time.current = 10
    stream.controller!.enqueue(encoder.encode('data: {"type":"start","messageId":"a"}\n\n'))
    await reader.read()
    expect(telemetry.buildPayload('success')).not.toHaveProperty('ttft_ms')

    time.current = 15
    stream.controller!.enqueue(encoder.encode('data: {"type":"text-delta","id":"text-1","delta":""}\n\n'))
    await reader.read()
    expect(telemetry.buildPayload('success')).not.toHaveProperty('ttft_ms')

    time.current = 20
    stream.controller!.enqueue(encoder.encode('data: {"type":"text-d'))
    await reader.read()
    expect(telemetry.buildPayload('success')).not.toHaveProperty('ttft_ms')

    time.current = 25
    stream.controller!.enqueue(encoder.encode('elta","id":"text-1","delta":"Hello"}\n\n'))
    await reader.read()
    expect(telemetry.buildPayload('success').ttft_ms).toBe(25)

    time.current = 40
    stream.controller!.enqueue(
      encoder.encode('data: {"type":"reasoning-delta","id":"reasoning-1","delta":"Later"}\n\n'),
    )
    await reader.read()
    expect(telemetry.buildPayload('success').ttft_ms).toBe(25)

    stream.controller!.close()
    await reader.read()
  })

  it('passes the stream through without parsing once the first content delta is seen', async () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })
    const markFirstToken = spyOn(telemetry, 'markFirstToken')
    const stream = { controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
    const adapterResponse = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          stream.controller = controller
        },
      }),
    )
    const adapter = {
      ...makeAdapter(builtInAgent),
      fetch: async () => adapterResponse,
    }
    const fetch = createAgentRoutingFetch(
      sessionId,
      async () => {},
      httpClient,
      getProxyFetch,
      {
        getAvailableModels: async () => useChatStore.getState().models,
        isAgentActive,
        getChatReasoningEffort: async () => undefined,
        getOrConnectAdapter: (async () => adapter) as never,
        updateChatThread: (async () => {}) as never,
        getDb: (() => ({})) as never,
      },
      { getTurnTelemetry: () => telemetry },
    )

    const response = await fetch('https://x', { body: '{}' } as RequestInit)
    const reader = response.body!.getReader()
    const encoder = new TextEncoder()
    const received: string[] = []
    const readChunk = async () => {
      const { value } = await reader.read()
      received.push(new TextDecoder().decode(value))
    }

    const firstDelta = 'data: {"type":"text-delta","id":"text-1","delta":"Hello"}\n\n'
    stream.controller!.enqueue(encoder.encode(firstDelta))
    await readChunk()
    expect(markFirstToken).toHaveBeenCalledTimes(1)

    // Past the first-token latch the wrapper is a pure pass-through: no more
    // decoding or JSON.parse, so markFirstToken is never consulted again.
    const secondDelta = 'data: {"type":"text-delta","id":"text-1","delta":" world"}\n\n'
    stream.controller!.enqueue(encoder.encode(secondDelta))
    await readChunk()
    expect(markFirstToken).toHaveBeenCalledTimes(1)
    expect(telemetry.buildPayload('success').ttft_ms).toBe(0)

    stream.controller!.close()
    await reader.read()
    expect(received.join('')).toBe(firstDelta + secondDelta)
  })
})

describe('createChatInstance — retry policy', () => {
  beforeEach(() => {
    resetStore()
    sessionStorage.clear()
  })

  afterEach(() => {
    setDebugTranscriptCaptureEnabled(false)
    resetStore()
    sessionStorage.clear()
  })

  it('keeps browser activity through retry backoff and releases it when the turn succeeds', async () => {
    const browser = trackBrowserTurns()
    const { finishWithError, finishSuccessfully, instance, trackEvent } = createRetryHarness()
    try {
      await instance.sendMessage({ text: 'Use the browser' })
      const traceId = trackEvent.mock.calls.find(([event]) => event === 'chat_send_prompt')?.[1]?.trace_id
      expect(typeof traceId).toBe('string')
      if (typeof traceId !== 'string') {
        throw new Error('Expected the turn to have a trace id')
      }
      expect([...browser.active]).toEqual([traceId])

      await finishWithError()
      expect([...browser.active]).toEqual([traceId])
      await getClock().tickAsync(3_000)
      expect([...browser.active]).toEqual([traceId])
      expect(browser.start).toHaveBeenCalledTimes(1)

      await finishSuccessfully()
      expect(browser.active.size).toBe(0)
    } finally {
      browser.start.mockRestore()
    }
  })

  it('releases browser activity on a terminal model error', async () => {
    const browser = trackBrowserTurns()
    const { finishWithError, instance } = createRetryHarness()
    try {
      await instance.sendMessage({ text: 'Use the browser' })
      await finishWithError(new Error(JSON.stringify({ kind: 'provider-error', isRetryable: false })))
      expect(browser.active.size).toBe(0)
    } finally {
      browser.start.mockRestore()
    }
  })

  it.each(['submitted', 'streaming'] as const)(
    'releases browser activity immediately when Stop interrupts %s',
    async (status) => {
      const browser = trackBrowserTurns()
      const { instance } = createRetryHarness()
      try {
        await instance.sendMessage({ text: 'Use the browser' })
        ;(instance as unknown as { status: string }).status = status
        await instance.stop()
        expect(browser.active.size).toBe(0)
      } finally {
        browser.start.mockRestore()
      }
    },
  )

  it('releases browser activity when a turn aborts without an explicit Stop', async () => {
    const browser = trackBrowserTurns()
    const { finishAborted, instance } = createRetryHarness()
    try {
      await instance.sendMessage({ text: 'Use the browser' })
      await finishAborted()
      expect(browser.active.size).toBe(0)
    } finally {
      browser.start.mockRestore()
    }
  })

  it('releases browser activity when Stop cancels retry backoff', async () => {
    const browser = trackBrowserTurns()
    const { finishWithError, instance } = createRetryHarness()
    try {
      await instance.sendMessage({ text: 'Use the browser' })
      await finishWithError()
      expect(browser.active.size).toBe(1)
      await instance.stop()
      expect(browser.active.size).toBe(0)
    } finally {
      browser.start.mockRestore()
    }
  })

  it('releases an unfinished browser turn when a new prompt supersedes it', async () => {
    const browser = trackBrowserTurns()
    const { instance } = createRetryHarness()
    try {
      await instance.sendMessage({ text: 'First browser turn' })
      const firstId = [...browser.active][0]
      await instance.sendMessage({ text: 'Second browser turn' })
      expect(browser.active.size).toBe(1)
      expect(browser.active.has(firstId!)).toBe(false)
      expect(browser.start).toHaveBeenCalledTimes(2)
    } finally {
      browser.start.mockRestore()
    }
  })

  it('keeps a newer browser turn active when an older final save completes', async () => {
    const browser = trackBrowserTurns()
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishSuccessfully, instance } = createRetryHarness(saveMessages)
    try {
      await instance.sendMessage({ text: 'First browser turn' })
      const firstFinish = finishSuccessfully()
      expect(browser.active.size).toBe(0)

      await instance.sendMessage({ text: 'Second browser turn' })
      const secondId = [...browser.active][0]
      expect(secondId).toBeDefined()
      resolveSave(0)
      await firstFinish
      expect([...browser.active]).toEqual([secondId])
    } finally {
      browser.start.mockRestore()
    }
  })

  it.each(['success', 'error'] as const)(
    'releases browser activity if saving the final %s response fails',
    async (outcome) => {
      const browser = trackBrowserTurns()
      const { finishSuccessfully, finishWithError, instance } = createRetryHarness(async () => {
        throw new Error('Final save failed')
      })
      try {
        await instance.sendMessage({ text: 'Use the browser' })
        const finished =
          outcome === 'success'
            ? finishSuccessfully()
            : finishWithError(undefined, {
                id: 'partial',
                role: 'assistant',
                parts: [{ type: 'text', text: 'Partial' }],
              })
        await expect(Promise.resolve(finished)).rejects.toThrow('Final save failed')
        expect(browser.active.size).toBe(0)
      } finally {
        browser.start.mockRestore()
      }
    },
  )

  it('uses 2s, 4s, and 8s exponential retry delays', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const { finishWithError, regenerate } = createRetryHarness()

    try {
      for (const [completedRetries, delay] of [2_000, 4_000, 8_000].entries()) {
        await finishWithError()

        await getClock().tickAsync(delay - 1)
        expect(regenerate).toHaveBeenCalledTimes(completedRetries)

        await getClock().tickAsync(1)
        expect(regenerate).toHaveBeenCalledTimes(completedRetries + 1)
      }
    } finally {
      random.mockRestore()
    }
  })

  it('retries an empty turn after 250ms with reason empty-response', async () => {
    const { finishSuccessfully, regenerate, trackEvent } = createRetryHarness()

    await finishSuccessfully({ id: 'empty-assistant', role: 'assistant', parts: [] })

    await getClock().tickAsync(249)
    expect(regenerate).not.toHaveBeenCalled()

    await getClock().tickAsync(1)
    expect(regenerate).toHaveBeenCalledTimes(1)

    const autoRetry = trackEvent.mock.calls.find(([event]) => event === 'chat_auto_retry')?.[1]
    expect(autoRetry?.reason).toBe('empty-response')
    expect(autoRetry?.attempt).toBe(1)
  })

  it.each([
    { state: 'input-streaming', input: undefined },
    { state: 'input-available', input: { path: 'index.html' } },
    { state: 'output-available', input: { path: 'index.html' }, output: 'File written' },
    { state: 'output-error', input: { path: 'index.html' }, errorText: 'Connection lost after writing' },
  ] as const)('keeps a failed turn with a $state tool for explicit Retry', async (toolState) => {
    const saved: ThunderboltUIMessage[] = []
    const { instance, finishWithError, regenerate, trackEvent } = createRetryHarness(async ({ messages }) => {
      saved.push(...messages)
    })
    const partial: ThunderboltUIMessage = {
      id: 'partial-assistant',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Creating the page' },
        { type: 'dynamic-tool', toolName: 'write', toolCallId: 'write-1', ...toolState },
      ],
    }
    instance.messages = [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Create a page' }] }, partial]

    await finishWithError(new Error('503: temporarily unavailable'), partial)
    await getClock().tickAsync(60_000)

    expect(regenerate).not.toHaveBeenCalled()
    expect(saved.at(-1)?.parts).toEqual(partial.parts)
    expect(instance.messages.at(-1)?.parts).toEqual(partial.parts)
    expect(useChatStore.getState().sessions.get(sessionId)).toMatchObject({ retryCount: 0, retriesExhausted: true })
    expect(trackEvent.mock.calls.find(([event]) => event === 'chat_retries_exhausted')?.[1]?.reason).toBe(
      'tool_execution_started',
    )

    await instance.regenerate()
    expect(regenerate).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions.get(sessionId)?.retriesExhausted).toBe(false)
  })

  it('still retries a plain response when only a previous turn used tools', async () => {
    const { instance, finishWithError, regenerate } = createRetryHarness()
    instance.messages = [
      { id: 'old-user', role: 'user', parts: [{ type: 'text', text: 'Create a page' }] },
      {
        id: 'old-assistant',
        role: 'assistant',
        parts: [{ type: 'tool-write', toolCallId: 'write-1', state: 'output-available', input: {}, output: 'Written' }],
      },
      { id: 'new-user', role: 'user', parts: [{ type: 'text', text: 'Explain the design' }] },
    ]
    await finishWithError(new Error('503: temporarily unavailable'), {
      id: 'new-assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: 'The design uses' }],
    })
    await getClock().tickAsync(3_000)
    expect(regenerate).toHaveBeenCalledTimes(1)
  })

  it('drops the empty shell of an aborted loader turn without re-sending it', async () => {
    const { instance, finishAbortedEmpty, wouldAutoSend } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'submitted'
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'How are you' }] },
      { id: 'a-empty', role: 'assistant', parts: [] },
    ] as never

    await instance.stop()
    await finishAbortedEmpty()

    // Two halves of one invariant, asserted together because each masks the
    // other's regression: kept, the shell renders an empty-turn recovery spinner
    // nothing will recover; dropped without the `stopRequested` gate, the now
    // trailing user message makes the SDK re-send the stopped turn.
    expect(instance.messages).toHaveLength(1)
    expect(instance.messages[0]!.role).toBe('user')
    expect(wouldAutoSend()).toBe(false)
  })

  it('flags and saves the prompt when stop() cancels a running reply', async () => {
    const saved: ThunderboltUIMessage[] = []
    const { instance, finishAbortedEmpty } = createRetryHarness(async ({ messages }) => {
      saved.push(...messages)
    })
    Object.assign(instance, { status: 'submitted' })
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Write an essay' }] },
      { id: 'a-empty', role: 'assistant', parts: [] },
    ] as never

    await instance.stop()
    await finishAbortedEmpty()

    expect(instance.messages[0]!.metadata?.stoppedByUser).toBe(true)
    expect(saved.map((message) => [message.id, message.metadata?.stoppedByUser])).toEqual([['u1', true]])
  })

  it('flags the stopped prompt, not one sent before the aborted request unwinds', async () => {
    const { instance, finishAborted } = createRetryHarness()
    Object.assign(instance, { status: 'streaming' })
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Write an essay' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] },
    ] as never

    await instance.stop()
    instance.messages = [
      ...instance.messages,
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Which city?' }] },
    ]
    await finishAborted()

    expect(instance.messages.map((message) => message.metadata?.stoppedByUser)).toEqual([true, undefined, undefined])
  })

  it('clears the stop flag when the prompt is regenerated', async () => {
    const { instance } = createRetryHarness()
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Write an essay' }], metadata: { stoppedByUser: true } },
    ]

    await instance.regenerate()

    expect(instance.messages[0]!.metadata?.stoppedByUser).toBe(false)
  })

  it('flags the prompt when stop() cancels a pending retry, without resetting a turn started meanwhile', async () => {
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishWithError, getTurnBudget, instance } = createRetryHarness(saveMessages)
    instance.messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Write an essay' }] }] as never
    await finishWithError()

    const stopped = instance.stop()
    await instance.sendMessage({ text: 'Which city?' })
    const newTurnBudget = getTurnBudget()
    resolveSave(0)
    await stopped

    expect(instance.messages[0]!.metadata?.stoppedByUser).toBe(true)
    expect(getTurnBudget()).toBe(newTurnBudget)
  })

  it('does not flag the last prompt when stop() runs with nothing in flight', async () => {
    const { instance } = createRetryHarness()
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
    ] as never

    await instance.stop()

    expect(instance.messages[0]!.metadata?.stoppedByUser).toBeUndefined()
  })

  it('settles the composer to idle after an aborted loader turn', async () => {
    const { instance, finishAbortedEmpty } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'submitted'
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'How are you' }] },
      { id: 'a-empty', role: 'assistant', parts: [] },
    ] as never

    await instance.stop()
    await finishAbortedEmpty()

    const session = useChatStore.getState().sessions.get(sessionId)
    const activity = getTurnActivity({
      status: 'ready',
      lastMessage: instance.messages[instance.messages.length - 1],
      hasChatError: false,
      retriesExhausted: session?.retriesExhausted ?? false,
      retryCount: session?.retryCount ?? 0,
      stopRequested: session?.stopping ?? false,
    })
    expect(activity.isActive).toBe(false)
  })

  it('suppresses the SDK auto-send after a stop, so the turn cannot restart itself', async () => {
    const { instance, wouldAutoSend } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'submitted'
    // Stop pressed while the model was still thinking: nothing streamed, so no
    // assistant message was ever pushed and the user message is trailing.
    instance.messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never

    expect(wouldAutoSend()).toBe(true)

    await instance.stop()

    expect(wouldAutoSend()).toBe(false)
  })

  it('lifts the auto-send suppression on the next explicit send', async () => {
    const { instance, wouldAutoSend } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'submitted'
    instance.messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as never

    await instance.stop()
    await instance.sendMessage({ text: 'again' })

    expect(wouldAutoSend()).toBe(true)
  })

  it('stop() flags the session as stopping while the abort unwinds', async () => {
    const { instance } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'streaming'

    await instance.stop()

    expect(useChatStore.getState().sessions.get(sessionId)?.stopping).toBe(true)
  })

  it('keeps the session stopping after the aborted turn settles, until the next explicit send', async () => {
    const { instance, finishAbortedEmpty } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'submitted'
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'How are you' }] },
      { id: 'a-empty', role: 'assistant', parts: [] },
    ] as never

    await instance.stop()
    await finishAbortedEmpty()

    // Dropping the shell leaves the user message trailing — the exact shape
    // useChatAutomation auto-runs. The flag must survive the turn settling
    // so Stop cannot restart the turn it cancelled.
    expect(useChatStore.getState().sessions.get(sessionId)?.stopping).toBe(true)

    await instance.sendMessage({ text: 'again' })

    expect(useChatStore.getState().sessions.get(sessionId)?.stopping).toBe(false)
  })

  it('resolves an open tool-permission dialog when the turn is stopped', async () => {
    const { instance } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'streaming'
    const resolve = mock((_response: RequestPermissionResponse) => {})
    useChatStore.getState().setPendingPermission(sessionId, {
      agentId: 'agent-1',
      requestId: 'req-1',
      request: {} as never,
      resolve,
    })

    await instance.stop()

    // Left pending, the dialog stays on screen awaiting an answer the cancelled
    // turn will never consume.
    expect(resolve).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } })
    expect(useChatStore.getState().sessions.get(sessionId)?.pendingPermission).toBeNull()
  })

  it('finalizes a reasoning part left streaming when a turn is aborted mid-thinking', async () => {
    const { instance, finishAborted } = createRetryHarness()
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'List things' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'reasoning', text: 'The user is asking…', state: 'streaming' }] },
    ] as never

    await finishAborted()

    // Left streaming, the reasoning part keeps its spinner running after the stop
    // (reasoning-group.tsx) even though the turn has settled.
    const last = instance.messages[instance.messages.length - 1] as { parts: Array<{ state?: string }> }
    expect(last.parts[0]!.state).toBe('done')
  })

  it('keeps a partial assistant message when an aborted turn had content', async () => {
    const { instance, finishAborted } = createRetryHarness()
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'How are you' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] },
    ] as never

    await finishAborted()

    expect(instance.messages).toHaveLength(2)
    expect(instance.messages[1]!.role).toBe('assistant')
  })

  it('stop() delegates an in-flight abort to onFinish (no drop/reset in the handler)', async () => {
    const { instance } = createRetryHarness()
    ;(instance as unknown as { status: string }).status = 'streaming'
    instance.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [] },
    ] as never

    await instance.stop()

    // The abort's onFinish settles the turn on the correct `currentTurn`; the
    // handler must not swap it out early, so it neither drops the shell nor resets.
    expect(instance.messages).toHaveLength(2)
  })

  it('stop() cancels a pending auto-retry and settles the session to idle', async () => {
    const { finishWithError, regenerate, instance } = createRetryHarness()

    await finishWithError()
    // A retry is scheduled and the store reflects the in-flight recovery.
    expect(useChatStore.getState().sessions.get(sessionId)?.retryCount).toBe(1)

    await instance.stop()

    // The scheduled retry is cancelled — advancing past every backoff never fires.
    await getClock().tickAsync(30_000)
    expect(regenerate).not.toHaveBeenCalled()

    const session = useChatStore.getState().sessions.get(sessionId)
    expect(session?.retryCount).toBe(0)
    expect(session?.retriesExhausted).toBe(false)
  })

  it('keeps exponential backoff for empty-turn retries after the first', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const { finishSuccessfully, regenerate } = createRetryHarness()

    try {
      await finishSuccessfully({ id: 'empty-assistant', role: 'assistant', parts: [] })
      await getClock().tickAsync(250)
      expect(regenerate).toHaveBeenCalledTimes(1)

      await finishSuccessfully({ id: 'empty-assistant', role: 'assistant', parts: [] })
      await getClock().tickAsync(3_999)
      expect(regenerate).toHaveBeenCalledTimes(1)

      await getClock().tickAsync(1)
      expect(regenerate).toHaveBeenCalledTimes(2)
    } finally {
      random.mockRestore()
    }
  })

  it('labels empty-turn retry exhaustion with empty-response reason', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const { finishSuccessfully, trackEvent } = createRetryHarness()
    const emptyMessage = { id: 'empty-assistant', role: 'assistant' as const, parts: [] }

    try {
      await finishSuccessfully(emptyMessage)
      await getClock().tickAsync(250)

      await finishSuccessfully(emptyMessage)
      await getClock().tickAsync(4_000)

      await finishSuccessfully(emptyMessage)
      await getClock().tickAsync(8_000)

      await finishSuccessfully(emptyMessage)

      const exhausted = trackEvent.mock.calls.find(([event]) => event === 'chat_retries_exhausted')?.[1]
      expect(exhausted?.reason).toBe('empty-response')
    } finally {
      random.mockRestore()
    }
  })

  it('marks retries exhausted when the scheduled retry bails on session switch', async () => {
    const { finishSuccessfully, regenerate } = createRetryHarness()

    await finishSuccessfully({ id: 'empty-assistant', role: 'assistant', parts: [] })
    useChatStore.getState().setCurrentSessionId('another-session')

    await getClock().tickAsync(250)

    expect(regenerate).not.toHaveBeenCalled()
    const session = useChatStore.getState().sessions.get(sessionId)!
    expect(session.retryCount).toBe(0)
    expect(session.retriesExhausted).toBe(true)
  })

  it('marks retries exhausted without scheduling when turn budget is exhausted', async () => {
    const { finishWithError, getTurnBudget, regenerate } = createRetryHarness()
    exhaustTurnBudget(getTurnBudget())

    await finishWithError()
    await getClock().runAllAsync()

    const session = useChatStore.getState().sessions.get(sessionId)!
    expect(session.retryCount).toBe(0)
    expect(session.retriesExhausted).toBe(true)
    expect(regenerate).not.toHaveBeenCalled()
  })

  it('never auto-regenerates a turn interrupted by connection loss', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const { finishWithError, regenerate } = createRetryHarness()

    try {
      await finishWithError(new Error(JSON.stringify({ error: 'relay dropped', kind: 'connection-lost' })))
      await getClock().runAllAsync()

      const session = useChatStore.getState().sessions.get(sessionId)!
      expect(session.retryCount).toBe(0)
      expect(session.retriesExhausted).toBe(true)
      expect(regenerate).not.toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })

  it.each([
    ['saves the flag when the chat has a thread', createMockChatThread({ id: sessionId }), true],
    ['saves nothing when the chat has no thread yet', null, false],
  ] as const)(
    'flags a prompt refused because its agent was disabled or deleted, and %s',
    async (_label, chatThread, persisted) => {
      const errorLog = spyOn(console, 'error').mockImplementation(() => {})
      const saved: ThunderboltUIMessage[] = []
      const { instance, finishWithError, regenerate } = createRetryHarness(async ({ messages }) => {
        saved.push(...messages)
      })
      useChatStore.getState().updateSession(sessionId, { chatThread })
      instance.messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }]

      try {
        await finishWithError(createAgentUnavailableError('agent-1'))
        await getClock().runAllAsync()

        // A reload's auto-run skips a stopped prompt, so it never reaches a fallback agent.
        expect(instance.messages[0]!.metadata?.stoppedByUser).toBe(true)
        expect(saved.map((message) => [message.id, message.metadata?.stoppedByUser])).toEqual(
          persisted ? [['u1', true]] : [],
        )
        expect(useChatStore.getState().sessions.get(sessionId)!.retriesExhausted).toBe(true)
        expect(regenerate).not.toHaveBeenCalled()
      } finally {
        errorLog.mockRestore()
      }
    },
  )

  it.each([
    ['an Ollama 400', '400: {"error":{"message":"registry.ollama.ai/library/gemma3:4b does not support tools"}}'],
    ['a llama.cpp 500', '500: tools param requires --jinja flag'],
  ])('never auto-regenerates %s that rejects tools', async (_label, message) => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const { finishWithError, regenerate } = createRetryHarness()

    try {
      await finishWithError(new Error(message))
      await getClock().runAllAsync()

      const session = useChatStore.getState().sessions.get(sessionId)!
      expect(session.retryCount).toBe(0)
      expect(session.retriesExhausted).toBe(true)
      expect(regenerate).not.toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })

  it('never auto-regenerates a pi-ai flattened JSON 429', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const { finishWithError, regenerate, trackEvent } = createRetryHarness()

    try {
      await finishWithError(new Error('429 {"code":"INFERENCE_QUOTA_EXCEEDED","window":"5h"}'))
      await getClock().runAllAsync()

      const session = useChatStore.getState().sessions.get(sessionId)!
      expect(session.retryCount).toBe(0)
      expect(session.retriesExhausted).toBe(true)
      expect(regenerate).not.toHaveBeenCalled()
      expect(trackEvent).toHaveBeenCalledWith(
        'chat_turn_error',
        expect.objectContaining({ kind: 'rate-limit', status: 429 }),
      )
      expect(trackEvent).toHaveBeenCalledWith(
        'chat_retries_exhausted',
        expect.objectContaining({ reason: 'rate-limit', attempts: 1 }),
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  it('retries a hosted-agent turn refused for a run in progress, after a longer delay', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const { finishWithError, regenerate } = createRetryHarness()
    const runInProgress = JSON.stringify({
      error: JSON.stringify({ error: { code: 'AGENT_RUN_IN_PROGRESS' } }),
      status: 429,
      kind: 'rate-limit',
    })

    try {
      await finishWithError(new Error(runInProgress))
      await getClock().tickAsync(9_999)
      expect(regenerate).not.toHaveBeenCalled()

      await getClock().tickAsync(1)
      expect(regenerate).toHaveBeenCalledTimes(1)
      expect(useChatStore.getState().sessions.get(sessionId)!.retryCount).toBe(1)
    } finally {
      random.mockRestore()
      errorLog.mockRestore()
    }
  })

  it('records the model a retry runs on, so a later tool rejection names it', async () => {
    const { instance, regenerate } = createRetryHarness()
    instance.messages = [
      { id: 'prompt', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { modelId: 'previous-model' } },
    ]

    await instance.regenerate()

    expect(instance.messages[0].metadata?.modelId).toBe('m1')
    expect(regenerate).toHaveBeenCalledTimes(1)
  })

  it('leaves the history untouched when a retry runs on the same model', async () => {
    const { instance } = createRetryHarness()
    const history: ThunderboltUIMessage[] = [
      { id: 'prompt', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { modelId: 'm1' } },
    ]
    instance.messages = history

    await instance.regenerate()

    expect(instance.messages).toBe(history)
  })

  it('manual regenerate resets the turn budget', async () => {
    const { getTurnBudget, instance, regenerate, wakeAdapterReconnect } = createRetryHarness()
    const exhaustedBudget = exhaustTurnBudget(getTurnBudget())

    await instance.regenerate()

    expect(getTurnBudget()).not.toBe(exhaustedBudget)
    expect(getTurnBudget().probe.isExhausted).toBe(false)
    expect(getTurnBudget().consumer.tryConsumeRequest()).toBe(true)
    expect(regenerate).toHaveBeenCalledTimes(1)
    expect(wakeAdapterReconnect).toHaveBeenCalledWith(builtInAgent.id)
  })

  it.each([
    ['the built-in agent', builtInAgent, true],
    ['the hosted agent, which ignores the selected model', { ...builtInAgent, type: 'managed-http' } as Agent, false],
  ])("enforces a private chat's model lock for %s: %p", async (_label, agent, enforced) => {
    const { instance, sendMessage } = createRetryHarness()
    useChatStore.getState().updateSession(sessionId, {
      selectedAgent: agent,
      chatThread: createMockChatThread({ id: sessionId, isEncrypted: 1 }),
    })

    const sending = instance.sendMessage({ text: 'hi' })

    if (enforced) {
      await expect(sending).rejects.toThrow('This model is not available for encrypted conversations.')
      expect(sendMessage).not.toHaveBeenCalled()
    } else {
      await sending
      expect(sendMessage).toHaveBeenCalledTimes(1)
    }
  })

  it.each([
    { models: [] },
    { models: [createMockModel({ id: 'm1', apiKey: null })] },
    { models: [createMockModel({ id: 'm1', enabled: 0 })] },
  ])('blocks sends when the selected provider is no longer usable (%p)', async ({ models }) => {
    const { instance, sendMessage } = createRetryHarness()
    useChatStore.getState().setModels([...models])
    await expect(instance.sendMessage({ text: 'hi' })).rejects.toThrow('Configure and select an available model')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('throws the friendly guard (not a TypeError) when a turn starts with no selected model', async () => {
    const { instance, regenerate } = createRetryHarness()
    useChatStore.getState().updateSession(sessionId, { selectedModel: null as never })

    await expect(instance.sendMessage({ text: 'hi' })).rejects.toThrow('No selected model')
    await expect(instance.regenerate()).resolves.toBeUndefined()
    expect(regenerate).toHaveBeenCalledTimes(1)
  })

  it('auto-retry does not reset the turn budget', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const { finishWithError, getTurnBudget, regenerate } = createRetryHarness()
    const budget = getTurnBudget()
    budget.consumer.tryConsumeRequest()

    try {
      await finishWithError()
      await getClock().tickAsync(2_000)

      expect(regenerate).toHaveBeenCalledTimes(1)
      expect(getTurnBudget()).toBe(budget)
      for (let request = 1; request < maxRequestsPerTurn; request++) {
        expect(budget.consumer.tryConsumeRequest()).toBe(true)
      }
      expect(budget.consumer.tryConsumeRequest()).toBe(false)
    } finally {
      random.mockRestore()
    }
  })

  it('resets the turn budget after success so the next automatic turn starts fresh', async () => {
    const { finishSuccessfully, getTurnBudget } = createRetryHarness()
    const exhaustedBudget = exhaustTurnBudget(getTurnBudget())

    await finishSuccessfully()

    expect(getTurnBudget()).not.toBe(exhaustedBudget)
    expect(getTurnBudget().probe.isExhausted).toBe(false)
    expect(getTurnBudget().consumer.tryConsumeRequest()).toBe(true)
  })

  it('user send resets the turn budget', async () => {
    const { getTurnBudget, instance, sendMessage } = createRetryHarness()
    const exhaustedBudget = exhaustTurnBudget(getTurnBudget())

    await instance.sendMessage({ text: 'new turn' })

    expect(getTurnBudget()).not.toBe(exhaustedBudget)
    expect(getTurnBudget().probe.isExhausted).toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('counts text parts in prompt telemetry', async () => {
    const { instance, trackEvent } = createRetryHarness()
    const prompt = 'Summarize the telemetry behavior of this non-empty prompt without exposing it.'

    await instance.sendMessage({ parts: [{ type: 'text', text: prompt }] })

    const sendProperties = trackEvent.mock.calls.find(([event]) => event === 'chat_send_prompt')?.[1]
    expect(sendProperties).toEqual(expect.objectContaining({ length: prompt.length }))
  })

  it.each(['completed', 'error', 'stopped'] as const)(
    'persists the %s terminal outcome while preserving existing metadata',
    async (outcome) => {
      const saved: ThunderboltUIMessage[] = []
      const { instance, finishSuccessfully, finishWithError, finishAborted } = createRetryHarness(
        async ({ messages }) => {
          saved.push(...messages)
        },
      )
      const partial: ThunderboltUIMessage = {
        id: outcome === 'stopped' ? 'aborted-assistant' : 'partial',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'Preserved thoughts', state: 'streaming' }],
        metadata: { modelId: 'selected-model', reasoningTime: { 'reasoning-0': 15 } },
      }
      instance.messages = [partial]
      if (outcome === 'completed') {
        await finishSuccessfully(partial)
      } else if (outcome === 'error') {
        await finishWithError(new Error(JSON.stringify({ kind: 'connection-lost', error: 'Connection lost' })), partial)
      } else {
        await finishAborted()
      }
      expect(saved.at(-1)?.metadata).toMatchObject({
        turnOutcome: outcome,
        modelId: 'selected-model',
        reasoningTime: { 'reasoning-0': 15 },
      })
      expect(instance.messages.at(-1)?.metadata?.turnOutcome).toBe(outcome)
    },
  )

  it('omits transcript correlation from persisted user and assistant messages when capture is disabled', async () => {
    const saveMessages = mock(async (_input: Parameters<SaveMessagesFunction>[0]) => {})
    const { finishSuccessfully, instance, sendMessage } = createRetryHarness(saveMessages)
    setDebugTranscriptCaptureEnabled(false)

    await instance.sendMessage({ text: 'disabled turn' })
    await finishSuccessfully()

    const sentMessage = sendMessage.mock.calls[0]?.[0]
    const savedMessage = saveMessages.mock.calls[0]?.[0].messages[0]
    expect(Object.hasOwn(sentMessage.metadata ?? {}, 'debugTranscript')).toBe(false)
    expect(Object.hasOwn(savedMessage?.metadata ?? {}, 'debugTranscript')).toBe(false)
  })

  it('stamps transcript correlation when capture is enabled', async () => {
    const saveMessages = mock(async (_input: Parameters<SaveMessagesFunction>[0]) => {})
    const { finishSuccessfully, instance, sendMessage } = createRetryHarness(saveMessages)
    setDebugTranscriptCaptureEnabled(true)

    await instance.sendMessage({ text: 'route this turn' })
    await finishSuccessfully()

    const sentMessage = sendMessage.mock.calls[0]?.[0]
    const savedMessage = saveMessages.mock.calls[0]?.[0].messages[0]
    expect(sentMessage.metadata?.debugTranscript?.engine).toBeNull()
    expect(Object.hasOwn(sentMessage.metadata ?? {}, 'debugTranscript')).toBe(true)
    expect(savedMessage?.metadata?.debugTranscript?.engine).toBe('legacy')
  })

  it.each([
    ['managed-http', 'hosted'],
    ['remote-acp', 'acp'],
  ] as const)('keeps a %s turn stamped as engine %p once it finishes', async (type, engine) => {
    const saveMessages = mock(async (_input: Parameters<SaveMessagesFunction>[0]) => {})
    const { finishSuccessfully, instance } = createRetryHarness(saveMessages)
    useChatStore.getState().updateSession(sessionId, { selectedAgent: { ...builtInAgent, type } })
    setDebugTranscriptCaptureEnabled(true)

    await instance.sendMessage({ text: 'route this turn' })
    await finishSuccessfully()

    expect(saveMessages.mock.calls[0]?.[0].messages[0]?.metadata?.debugTranscript?.engine).toBe(engine)
  })

  it('starts stamping only new messages after capture is enabled mid-session', async () => {
    const { instance, sendMessage } = createRetryHarness()
    setDebugTranscriptCaptureEnabled(false)

    await instance.sendMessage({ text: 'before enable' })
    const beforeEnable = sendMessage.mock.calls[0]?.[0]
    setDebugTranscriptCaptureEnabled(true)

    await instance.sendMessage({ text: 'after enable' })
    const afterEnable = sendMessage.mock.calls[1]?.[0]

    expect(Object.hasOwn(beforeEnable.metadata ?? {}, 'debugTranscript')).toBe(false)
    expect(Object.hasOwn(afterEnable.metadata ?? {}, 'debugTranscript')).toBe(true)
  })

  it('stops stamping only new messages after capture is disabled mid-session', async () => {
    const { instance, sendMessage } = createRetryHarness()
    setDebugTranscriptCaptureEnabled(true)

    await instance.sendMessage({ text: 'before disable' })
    const beforeDisable = sendMessage.mock.calls[0]?.[0]
    setDebugTranscriptCaptureEnabled(false)
    await instance.sendMessage({ text: 'after disable' })
    const afterDisable = sendMessage.mock.calls[1]?.[0]

    expect(Object.hasOwn(beforeDisable.metadata ?? {}, 'debugTranscript')).toBe(true)
    expect(Object.hasOwn(afterDisable.metadata ?? {}, 'debugTranscript')).toBe(false)
  })

  it('tracks scalar model identifiers and one correlated success summary', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()

    await instance.sendMessage({ text: 'new turn' })
    await finishSuccessfully()

    const sendCall = trackEvent.mock.calls.find(([event]) => event === 'chat_send_prompt')!
    const receiveCall = trackEvent.mock.calls.find(([event]) => event === 'chat_receive_reply')!
    const summaryCalls = trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed')
    const sendProperties = sendCall[1] as TurnTelemetryPayload
    const receiveProperties = receiveCall[1] as TurnTelemetryPayload
    const summaryProperties = summaryCalls[0]![1] as TurnTelemetryPayload

    expect(sendProperties).toMatchObject({ model_id: 'm1', model_name: 'claude-opus', provider: 'anthropic' })
    expect(receiveProperties).toMatchObject({ model_id: 'm1', model_name: 'claude-opus', provider: 'anthropic' })
    expect(JSON.stringify(sendProperties)).not.toContain('secret')
    expect(summaryCalls).toHaveLength(1)
    expect(summaryProperties.outcome).toBe('success')
    expect(sendProperties.trace_id).toBe(receiveProperties.trace_id)
    expect(receiveProperties.trace_id).toBe(summaryProperties.trace_id)
  })

  it('emits one terminal summary for abort and non-retryable error outcomes', async () => {
    const abortHarness = createRetryHarness()
    await abortHarness.instance.sendMessage({ text: 'abort turn' })
    await abortHarness.finishAborted()
    expect(
      abortHarness.trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed').map((call) => call[1]),
    ).toEqual([expect.objectContaining({ outcome: 'abort' })])

    const errorHarness = createRetryHarness()
    await errorHarness.instance.sendMessage({ text: 'error turn' })
    await errorHarness.finishWithError(
      new Error(JSON.stringify({ error: 'private provider message', kind: 'provider-error', isRetryable: false })),
    )
    const summaries = errorHarness.trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]![1]).toEqual(expect.objectContaining({ outcome: 'error', error_class: 'Error' }))
    expect(JSON.stringify(summaries[0]![1])).not.toContain('private provider message')
  })

  it('reports one total attempt when retries stop before the first retry', async () => {
    const { finishWithError, instance, trackEvent } = createRetryHarness()
    await instance.sendMessage({ text: 'do not retry' })

    await finishWithError(new Error(JSON.stringify({ kind: 'provider-error', isRetryable: false })))

    const exhausted = trackEvent.mock.calls.find(([event]) => event === 'chat_retries_exhausted')?.[1]
    const summary = trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
    expect(exhausted).toEqual(expect.objectContaining({ attempts: 1 }))
    expect(summary).toEqual(expect.objectContaining({ attempts: 1 }))
  })

  it('reports total attempts after an automatic retry', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const { finishWithError, instance, trackEvent } = createRetryHarness()

    try {
      await instance.sendMessage({ text: 'retry once' })
      await finishWithError()
      await getClock().tickAsync(2_000)
      await finishWithError(new Error(JSON.stringify({ kind: 'provider-error', isRetryable: false })))

      const exhausted = trackEvent.mock.calls.find(([event]) => event === 'chat_retries_exhausted')?.[1]
      const summary = trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
      expect(exhausted).toEqual(expect.objectContaining({ attempts: 2 }))
      expect(summary).toEqual(expect.objectContaining({ attempts: 2 }))
    } finally {
      random.mockRestore()
    }
  })

  it('keeps one trace across auto-retry attempts', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const { finishSuccessfully, finishWithError, instance, trackEvent } = createRetryHarness()

    try {
      await instance.sendMessage({ text: 'retry turn' })
      await finishWithError()
      await getClock().tickAsync(2_000)
      await finishSuccessfully()

      const retrySuccess = trackEvent.mock.calls.find(([event]) => event === 'chat_retry_success')?.[1]
      const summary = trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
      expect(retrySuccess).toEqual(expect.objectContaining({ attempts: 2 }))
      expect(summary).toEqual(expect.objectContaining({ attempts: 2, retry_layers: ['auto_retry'] }))
      expect(summary).not.toHaveProperty('error_class')
    } finally {
      random.mockRestore()
    }
  })

  it('emits one abort summary for a turn left in flight across reload', async () => {
    const firstBoot = createRetryHarness()
    await firstBoot.instance.sendMessage({ text: 'stream until reload' })
    const traceId = (
      firstBoot.trackEvent.mock.calls.find(([event]) => event === 'chat_send_prompt')?.[1] as
        | TurnTelemetryPayload
        | undefined
    )?.trace_id

    resetStore()
    const reloaded = createRetryHarness()

    expect(
      reloaded.trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed').map((call) => call[1]),
    ).toEqual([expect.objectContaining({ outcome: 'abort', trace_id: traceId, total_ms: expect.any(Number) })])

    resetStore()
    const nextBoot = createRetryHarness()
    expect(nextBoot.trackEvent.mock.calls.some(([event]) => event === 'chat_turn_completed')).toBe(false)
  })

  it('does not emit an abort summary on a fresh boot', () => {
    const { trackEvent } = createRetryHarness()

    expect(trackEvent.mock.calls.some(([event]) => event === 'chat_turn_completed')).toBe(false)
  })

  it('keeps retry events and summaries on the model that started the turn', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.5)
    const retryHarness = createRetryHarness()

    try {
      await retryHarness.instance.sendMessage({ text: 'retry turn' })
      useChatStore.getState().updateSession(sessionId, {
        selectedModel: {
          id: 'm2',
          model: 'gpt-5',
          provider: 'openai',
          isConfidential: 0,
        } as never,
      })
      await retryHarness.finishWithError()
      await getClock().tickAsync(2_000)
      await retryHarness.finishSuccessfully()

      const autoRetry = retryHarness.trackEvent.mock.calls.find(([event]) => event === 'chat_auto_retry')?.[1]
      const retrySuccess = retryHarness.trackEvent.mock.calls.find(([event]) => event === 'chat_retry_success')?.[1]
      const successSummary = retryHarness.trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
      expect(autoRetry).toEqual(expect.objectContaining({ model_id: 'm1', provider: 'anthropic' }))
      expect(retrySuccess).toEqual(expect.objectContaining({ model_id: 'm1', provider: 'anthropic' }))
      expect(successSummary).toEqual(expect.objectContaining({ model_id: 'm1', provider: 'anthropic' }))
      expect((autoRetry as TurnTelemetryPayload).trace_id).toBe((successSummary as TurnTelemetryPayload).trace_id)

      const exhaustedHarness = createRetryHarness()
      await exhaustedHarness.instance.sendMessage({ text: 'failed turn' })
      useChatStore.getState().updateSession(sessionId, {
        selectedModel: {
          id: 'm2',
          model: 'gpt-5',
          provider: 'openai',
          isConfidential: 0,
        } as never,
      })
      await exhaustedHarness.finishWithError(new Error(JSON.stringify({ kind: 'provider-error', isRetryable: false })))

      const retriesExhausted = exhaustedHarness.trackEvent.mock.calls.find(
        ([event]) => event === 'chat_retries_exhausted',
      )?.[1]
      const errorSummary = exhaustedHarness.trackEvent.mock.calls.find(
        ([event]) => event === 'chat_turn_completed',
      )?.[1]
      expect(retriesExhausted).toEqual(expect.objectContaining({ model_id: 'm1', provider: 'anthropic' }))
      expect(errorSummary).toEqual(expect.objectContaining({ model_id: 'm1', provider: 'anthropic' }))
      expect((retriesExhausted as TurnTelemetryPayload).trace_id).toBe((errorSummary as TurnTelemetryPayload).trace_id)
    } finally {
      random.mockRestore()
    }
  })

  it('normalizes dynamic tool timings without relying on MCP metadata', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()
    const namespacedToolName = 'private_customer_server_list_documents'

    await instance.sendMessage({ text: 'use a tool' })
    await finishSuccessfully({
      id: 'successful-assistant',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: namespacedToolName,
          toolCallId: 'call-1',
          state: 'output-available',
          input: {},
          output: {},
        },
      ],
      metadata: {
        reasoningTime: { 'call-1': 12 },
      },
    })

    const summary = trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
    expect(summary).toEqual(
      expect.objectContaining({
        tool_count: 1,
        tools: [{ name: 'mcp', duration_ms: 12 }],
      }),
    )
    expect(JSON.stringify(summary)).not.toContain('private_customer_server')
  })

  it('ignores malformed persisted tool durations', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()

    await instance.sendMessage({ text: 'use a tool' })
    await finishSuccessfully({
      id: 'successful-assistant',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'lookup',
          toolCallId: 'call-1',
          state: 'output-available',
          input: {},
          output: {},
        },
      ],
      metadata: {
        reasoningTime: { 'call-1': '12' as never },
      },
    })

    const summary = trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
    expect(summary).toEqual(expect.objectContaining({ tool_count: 0, tools: [] }))
  })

  it('emits terminal telemetry before transcript-only message processing', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()
    const parts: ThunderboltUIMessage['parts'] = [{ type: 'text', text: 'Done' }]
    Object.defineProperty(parts, 'flatMap', {
      value: () => {
        throw new Error('transcript extraction failed')
      },
    })

    await instance.sendMessage({ text: 'new turn' })
    await expect(
      finishSuccessfully({
        id: 'successful-assistant',
        role: 'assistant',
        parts,
      }),
    ).resolves.toBeUndefined()

    expect(trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]).toEqual(
      expect.objectContaining({ outcome: 'success' }),
    )
  })

  it('preserves built-in tool names in turn telemetry', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()

    await instance.sendMessage({ text: 'search the web' })
    await finishSuccessfully({
      id: 'successful-assistant',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_search',
          toolCallId: 'call-1',
          state: 'output-available',
          input: {},
          output: {},
        },
      ],
      metadata: {
        reasoningTime: { 'call-1': 9 },
      },
    })

    const summary = trackEvent.mock.calls.find(([event]) => event === 'chat_turn_completed')?.[1]
    expect(summary).toEqual(
      expect.objectContaining({
        tool_count: 1,
        tools: [{ name: 'web_search', duration_ms: 9 }],
      }),
    )
  })

  it('does not emit built-in turn summaries for external ACP agents', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()
    useChatStore.getState().updateSession(sessionId, {
      selectedAgent: {
        ...builtInAgent,
        id: 'external-agent',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://agent.test',
      },
    })

    await instance.sendMessage({ text: 'external turn' })
    await finishSuccessfully()

    expect(trackEvent.mock.calls.some(([event]) => event === 'chat_turn_completed')).toBe(false)
  })

  it('emits both summaries when the newer turn completes before the older save resumes', async () => {
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishSuccessfully, finishWithError, instance, trackEvent } = createRetryHarness(saveMessages)

    await instance.sendMessage({ text: 'first turn' })
    const firstFinish = finishSuccessfully()

    await instance.sendMessage({ text: 'second turn' })
    await finishWithError(new Error(JSON.stringify({ kind: 'provider-error', isRetryable: false })))

    resolveSave(0)
    await firstFinish

    const sendCalls = trackEvent.mock.calls.filter(([event]) => event === 'chat_send_prompt')
    const firstTrace = (sendCalls[0]![1] as TurnTelemetryPayload).trace_id
    const secondTrace = (sendCalls[1]![1] as TurnTelemetryPayload).trace_id
    const summaries = trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed')

    expect(firstTrace).toBeDefined()
    expect(secondTrace).toBeDefined()
    expect(firstTrace).not.toBe(secondTrace)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]![1]).toEqual(expect.objectContaining({ outcome: 'error', trace_id: secondTrace }))
    expect(summaries[1]![1]).toEqual(expect.objectContaining({ outcome: 'success', trace_id: firstTrace }))
  })

  it('does not let an older external turn reset a newer turn retry', async () => {
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishSuccessfully, finishWithError, getTurnBudget, instance, regenerate } =
      createRetryHarness(saveMessages)
    useChatStore.getState().updateSession(sessionId, {
      selectedAgent: {
        ...builtInAgent,
        id: 'external-agent',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://agent.test',
      },
    })

    await instance.sendMessage({ text: 'first external turn' })
    const firstFinish = finishSuccessfully()

    await instance.sendMessage({ text: 'second external turn' })
    const secondTurnBudget = getTurnBudget()
    await finishWithError()
    expect(useChatStore.getState().sessions.get(sessionId)!.retryCount).toBe(1)

    resolveSave(0)
    await firstFinish

    expect(getTurnBudget()).toBe(secondTurnBudget)
    expect(useChatStore.getState().sessions.get(sessionId)!.retryCount).toBe(1)
    await getClock().runAllAsync()
    expect(regenerate).toHaveBeenCalledTimes(1)
  })

  it('does not retry a newer turn when an older failed response finishes saving', async () => {
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishWithError, getTurnBudget, instance, regenerate, trackEvent } = createRetryHarness(saveMessages)

    await instance.sendMessage({ text: 'first turn' })
    const firstFinish = finishWithError(new Error('Connection failed'), {
      id: 'partial-assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Partial response' }],
    })

    await instance.sendMessage({ text: 'second turn' })
    const secondTurnBudget = getTurnBudget()
    resolveSave(0)
    await firstFinish

    expect(getTurnBudget()).toBe(secondTurnBudget)
    expect(useChatStore.getState().sessions.get(sessionId)!.retryCount).toBe(0)
    expect(useChatStore.getState().sessions.get(sessionId)!.retriesExhausted).toBe(false)
    await getClock().runAllAsync()
    expect(regenerate).not.toHaveBeenCalled()
    const summaries = trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]![1]).toEqual(expect.objectContaining({ outcome: 'error' }))
  })

  it('attributes a reply to the turn model when the session model changes mid-save', async () => {
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness(saveMessages)

    await instance.sendMessage({ text: 'first turn' })
    const finish = finishSuccessfully()
    useChatStore.getState().sessions.get(sessionId)!.selectedModel = {
      id: 'm2',
      model: 'gpt-5',
      provider: 'openai',
      isConfidential: 0,
    } as never

    resolveSave(0)
    await finish

    const reply = trackEvent.mock.calls.find(([event]) => event === 'chat_receive_reply')?.[1]
    expect(reply).toEqual(expect.objectContaining({ model_id: 'm1', model_name: 'claude-opus', provider: 'anthropic' }))
  })

  it('keeps a turn that starts mid-save on its own trace and state', async () => {
    const { resolveSave, saveMessages } = createDeferredSaveMessages()
    const { finishSuccessfully, getTurnBudget, instance, trackEvent } = createRetryHarness(saveMessages)

    await instance.sendMessage({ text: 'first turn' })
    const firstTurnBudget = getTurnBudget()

    // Park the first turn's onFinish inside its final saveMessages await.
    const finish = finishSuccessfully()

    // A new turn starting now swaps the shared turn state (telemetry, budget).
    await instance.sendMessage({ text: 'second turn' })
    const secondTurnBudget = getTurnBudget()
    expect(secondTurnBudget).not.toBe(firstTurnBudget)

    resolveSave(0)
    await finish

    const sendCalls = trackEvent.mock.calls.filter(([event]) => event === 'chat_send_prompt')
    const firstTrace = (sendCalls[0]![1] as TurnTelemetryPayload).trace_id
    const secondTrace = (sendCalls[1]![1] as TurnTelemetryPayload).trace_id
    expect(firstTrace).toBeDefined()
    expect(secondTrace).toBeDefined()
    expect(firstTrace).not.toBe(secondTrace)

    // The finished turn's events stay on ITS trace even though the new turn
    // installed fresh telemetry while the save was parked.
    const receiveCall = trackEvent.mock.calls.find(([event]) => event === 'chat_receive_reply')
    expect(receiveCall?.[1]).toEqual(expect.objectContaining({ trace_id: firstTrace }))
    const summaryCalls = () => trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed')
    expect(summaryCalls()).toHaveLength(1)
    expect(summaryCalls()[0]![1]).toEqual(expect.objectContaining({ outcome: 'success', trace_id: firstTrace }))
    expect(summaryCalls()[0]![1]).toHaveProperty('final_save_ms')

    // ...and the new turn keeps ownership of the shared retry/budget state.
    expect(getTurnBudget()).toBe(secondTurnBudget)

    // The old turn's emit must not block the new turn's own completion.
    const secondFinish = finishSuccessfully()
    resolveSave(1)
    await secondFinish
    expect(summaryCalls()).toHaveLength(2)
    expect(summaryCalls()[1]![1]).toEqual(expect.objectContaining({ outcome: 'success', trace_id: secondTrace }))
  })
})

/** Exercise routing, SDK transcript mutation and retry callbacks with only the agent response injected. */
const createWebRetryChat = (webCalls: number, errorText = '503: temporarily unavailable', promote = false) => {
  const attempts: Array<NonNullable<AgentAdapterContext['webToolBudget']>> = []
  const modelIds: string[] = []
  const adapter: AgentAdapter = {
    ...makeAdapter(builtInAgent),
    fetch: async (_init, context) => {
      const budget = context.webToolBudget!
      attempts.push(budget)
      modelIds.push(context.selectedModel.id)
      if (attempts.length === 1) {
        if (promote) {
          budget.promote('research')
        }
        for (let call = 0; call < webCalls; call++) {
          await budget.execute('search', { query: `query ${call}` }, async () => ({ title: `source ${call}` }))
        }
      }
      const chunks = [
        { type: 'start', messageId: `attempt-${attempts.length}` },
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: attempts.length === 1 ? 'Research already gathered' : 'Completed' },
        { type: 'text-end', id: 'text' },
        ...(attempts.length === 1 ? [{ type: 'error', errorText }] : []),
        { type: 'finish' },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  }
  const instance = createChatInstance(sessionId, [], async () => {}, httpClient, getProxyFetch, {
    getAvailableModels: async () => useChatStore.getState().models,
    getChatReasoningEffort: async () => undefined,
    getOrConnectAdapter: async () => adapter,
    trackEvent: () => {},
  })
  hydrateStore({
    chatInstance: instance,
    chatThread: null,
    id: sessionId,
    models: testModels,
    selectedModel: testModels[0],
    triggerData: null,
  })
  return { instance, attempts, modelIds }
}

describe('logical-turn web retry state through the SDK', () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it.each(['input-available', 'output-available'] as const)(
    'does not replay a streamed coding call after a provider failure (%s)',
    async (state) => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => {})
      const saved: ThunderboltUIMessage[] = []
      const requests: string[] = []
      const adapter: AgentAdapter = {
        ...makeAdapter(builtInAgent),
        fetch: async (init) => {
          requests.push(String(init.body))
          const firstAttempt = requests.length === 1
          const chunks = [
            { type: 'start', messageId: `attempt-${requests.length}` },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: firstAttempt ? 'Creating the page' : 'Completed' },
            { type: 'text-end', id: 'text' },
            ...(firstAttempt
              ? [
                  { type: 'tool-input-start', toolCallId: 'write-1', toolName: 'write' },
                  {
                    type: 'tool-input-available',
                    toolCallId: 'write-1',
                    toolName: 'write',
                    input: { path: 'index.html', content: '<h1>Hello</h1>' },
                  },
                  ...(state === 'output-available'
                    ? [{ type: 'tool-output-available', toolCallId: 'write-1', output: 'File written' }]
                    : []),
                  { type: 'error', errorText: '503: temporarily unavailable' },
                ]
              : []),
            { type: 'finish' },
          ]
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
            {
              headers: { 'Content-Type': 'text/event-stream' },
            },
          )
        },
      }
      const instance = createChatInstance(
        sessionId,
        [],
        async ({ messages }) => {
          saved.push(...messages)
        },
        httpClient,
        getProxyFetch,
        {
          getAvailableModels: async () => useChatStore.getState().models,
          getChatReasoningEffort: async () => undefined,
          getOrConnectAdapter: async () => adapter,
          trackEvent: () => {},
        },
      )
      hydrateStore({
        chatInstance: instance,
        chatThread: null,
        id: sessionId,
        models: testModels,
        selectedModel: testModels[0],
        triggerData: null,
      })
      try {
        await instance.sendMessage({ text: 'Create a page' })
        await getClock().tickAsync(60_000)

        expect(requests).toHaveLength(1)
        expect(instance.messages.at(-1)?.parts).toContainEqual(
          expect.objectContaining({ type: 'tool-write', toolCallId: 'write-1', state }),
        )
        expect(saved.at(-1)?.parts).toEqual(instance.messages.at(-1)?.parts)
        expect(useChatStore.getState().sessions.get(sessionId)).toMatchObject({
          retryCount: 0,
          retriesExhausted: true,
        })

        await instance.regenerate()
        expect(requests).toHaveLength(2)
        expect(instance.messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ text: 'Completed' }))
      } finally {
        await instance.stop()
        consoleError.mockRestore()
      }
    },
  )

  it.each([
    ['manual', 'removed'],
    ['manual', 'disabled'],
    ['automatic', 'removed'],
    ['automatic', 'disabled'],
  ] as const)('blocks %s retries after the BYOK model is %s', async (retry, change) => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const { instance, attempts } = createWebRetryChat(1)
    try {
      await instance.sendMessage({ text: 'Research a topic' })
      useChatStore.getState().setModels(change === 'removed' ? [] : [{ ...testModels[0], enabled: 0 }])
      // The placeholder deliberately retains its old key, but no request may use it.
      expect(useChatStore.getState().sessions.get(sessionId)?.selectedModel.apiKey).toBe('secret')
      if (retry === 'manual') {
        await instance.regenerate()
      } else {
        await getClock().tickAsync(5000)
      }
      expect(attempts).toHaveLength(1)
      expect(instance.error?.message).toContain('Configure and select an available model')
    } finally {
      await instance.stop()
      consoleError.mockRestore()
    }
  })

  it.each([false, true])(
    'does not schedule retries when access disappears during the first attempt (alternative: %s)',
    async (hasAlternative) => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => {})
      const readingModels = Promise.withResolvers<void>()
      const availableModels = Promise.withResolvers<typeof testModels>()
      const fetch = mock(async () => new Response('must not be used'))
      const getAvailableModels = mock(async () => {
        readingModels.resolve()
        return availableModels.promise
      })
      const instance = createChatInstance(sessionId, [], async () => {}, httpClient, getProxyFetch, {
        getAvailableModels,
        getChatReasoningEffort: async () => undefined,
        getOrConnectAdapter: async () => ({ ...makeAdapter(builtInAgent), fetch }),
        trackEvent: () => {},
      })
      hydrateStore({
        chatInstance: instance,
        chatThread: null,
        id: sessionId,
        models: testModels,
        selectedModel: testModels[0],
        triggerData: null,
      })
      try {
        const sending = instance.sendMessage({ text: 'Research a topic' })
        await readingModels.promise
        const changedModels = [
          { ...testModels[0], enabled: 0 },
          ...(hasAlternative ? [{ ...testModels[1], apiKey: 'other-key' }] : []),
        ]
        useChatStore.getState().setModels(changedModels)
        availableModels.resolve(changedModels)
        await sending
        expect(instance.error?.message).toContain('Configure and select an available model')
        await getClock().tickAsync(60_000)
        expect(fetch).not.toHaveBeenCalled()
        expect(getAvailableModels).toHaveBeenCalledTimes(1)
        expect(useChatStore.getState().sessions.get(sessionId)).toMatchObject({ retryCount: 0, retriesExhausted: true })
      } finally {
        await instance.stop()
        consoleError.mockRestore()
      }
    },
  )

  it.each([false, true])(
    'does not retry or switch providers after model disable (alternative: %s)',
    async (hasAlternative) => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => {})
      const { instance, attempts, modelIds } = createWebRetryChat(1)
      try {
        await instance.sendMessage({ text: 'Research a topic' })
        const alternative = { ...testModels[1], apiKey: 'other-key' }
        useChatStore.getState().setModels([{ ...testModels[0], enabled: 0 }, ...(hasAlternative ? [alternative] : [])])
        if (hasAlternative) {
          expect(useChatStore.getState().sessions.get(sessionId)?.selectedModel.id).toBe('m2')
        }
        await getClock().tickAsync(60_000)
        expect(attempts).toHaveLength(1)
        expect(modelIds).toEqual(['m1'])
        expect(instance.messages.findLast((message) => message.role === 'user')?.metadata?.modelId).toBe('m1')
        expect(instance.error?.message).toContain('Configure and select an available model')
        expect(useChatStore.getState().sessions.get(sessionId)).toMatchObject({ retryCount: 1, retriesExhausted: true })

        // A new user action is allowed to select and send through another model.
        useChatStore.getState().setModels([alternative])
        await instance.sendMessage({ text: 'Try a new question with the available model' })
        expect(modelIds).toEqual(['m1', 'm2'])
      } finally {
        await instance.stop()
        consoleError.mockRestore()
      }
    },
  )

  it('stops automatic retries when the model no longer matches the conversation privacy', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const { instance, modelIds } = createWebRetryChat(1)
    try {
      useChatStore
        .getState()
        .updateSession(sessionId, { chatThread: createMockChatThread({ id: sessionId, isEncrypted: 0 }) })
      await instance.sendMessage({ text: 'Research a topic' })
      useChatStore.getState().setModels([{ ...testModels[0], isConfidential: 1 }])
      await getClock().tickAsync(60_000)
      expect(modelIds).toEqual(['m1'])
      expect(instance.error?.message).toContain('no longer matches')
      expect(useChatStore.getState().sessions.get(sessionId)).toMatchObject({ retryCount: 1, retriesExhausted: true })
    } finally {
      await instance.stop()
      consoleError.mockRestore()
    }
  })

  it('uses a newly selected model on an explicit manual retry', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const { instance, modelIds } = createWebRetryChat(1)
    try {
      await instance.sendMessage({ text: 'Research a topic' })
      useChatStore.getState().setModels([{ ...testModels[1], apiKey: 'other-key' }])
      await instance.regenerate()
      expect(modelIds).toEqual(['m1', 'm2'])
      expect(instance.messages.findLast((message) => message.role === 'user')?.metadata?.modelId).toBe('m2')
      await getClock().tickAsync(60_000)
      expect(modelIds).toEqual(['m1', 'm2'])
    } finally {
      await instance.stop()
      consoleError.mockRestore()
    }
  })

  it('keeps an exhausted partial response before automatic regeneration can truncate it; manual Retry starts fresh', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { instance, attempts } = createWebRetryChat(webToolCaps.auto)
      await instance.sendMessage({ text: 'Research a topic' })
      const partial = [...instance.messages]
      await getClock().tickAsync(5000)
      expect(attempts).toHaveLength(1)
      expect(instance.messages).toEqual(partial)
      expect(instance.messages.at(-1)?.parts).toContainEqual({
        type: 'text',
        text: 'Research already gathered',
        state: 'done',
      })
      expect(useChatStore.getState().sessions.get(sessionId)?.retriesExhausted).toBe(true)
      await instance.regenerate()
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).not.toBe(attempts[0])
      expect(attempts[1]!.probe.isExhausted).toBe(false)
      expect(instance.messages.at(-1)?.parts).toContainEqual({ type: 'text', text: 'Completed', state: 'done' })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('retains the web budget on a below-cap transient retry after tool execution', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { instance, attempts } = createWebRetryChat(1)
      await instance.sendMessage({ text: 'Research a topic' })
      await getClock().tickAsync(5000)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toBe(attempts[0])
      for (let call = 1; call < webToolCaps.auto; call++) {
        await attempts[1]!.execute('search', { query: `remaining ${call}` }, async () => 'source')
      }
      expect(attempts[1]!.probe.isExhausted).toBe(true)
      await instance.sendMessage({ text: 'A new question' })
      expect(attempts[2]).not.toBe(attempts[0])
      expect(attempts[2]!.probe.isExhausted).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('preserves promotion, consumed calls and cache on automatic retry but starts a new turn at auto', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { instance, attempts } = createWebRetryChat(1, '503: temporarily unavailable', true)
      await instance.sendMessage({ text: 'Research a topic' })
      await getClock().tickAsync(5000)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toBe(attempts[0])
      expect(attempts[1].cap).toBe(30)
      expect(attempts[1].consumed).toBe(1)
      expect(
        await attempts[1].execute('search', { query: 'query 0' }, async () => {
          throw new Error('must be cached')
        }),
      ).toEqual({ title: 'source 0' })
      expect(attempts[1].consumed).toBe(1)
      await instance.sendMessage({ text: 'A new ordinary question' })
      expect(attempts[2].cap).toBe(webToolCaps.auto)
      expect(attempts[2].consumed).toBe(0)
      expect(attempts[2].promoted).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not automatically replay the exact tools-schema 400 after research', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { instance, attempts } = createWebRetryChat(
        1,
        '400: {"message":"tools must not be an empty array","type":"BadRequestError","param":"tools","code":400}',
      )
      await instance.sendMessage({ text: 'Research a topic' })
      await getClock().tickAsync(5000)
      expect(attempts).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })
})
