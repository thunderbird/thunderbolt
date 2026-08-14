/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `createAgentRoutingFetch` connection-status tests. Verifies the customFetch
 * factory writes `connectionStatus` transitions into the chat-store around
 * each call to the injected `connectToAgent`.
 */

import { createTurnBudget, maxRequestsPerTurn, type TurnBudget } from '@/ai/retry-budget'
import { createTurnTelemetry } from '@/ai/turn-telemetry'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { EventType } from '@/lib/posthog'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { Agent, AgentAdapter } from '@/types/acp'
import type { Chat } from '@ai-sdk/react'
import type { ChatInit, ChatOnFinishCallback } from 'ai'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useChatStore } from './chat-store'
import { createAgentRoutingFetch, createChatInstance } from './chat-instance'

const sessionId = 'sess-1'
const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn

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
    selectedModel: { id: 'm1', isConfidential: 0 } as never,
    triggerData: null,
  })
}

/** Build a chat instance whose retry callbacks and original methods are observable. */
const createRetryHarness = (saveMessages: SaveMessagesFunction = async () => {}) => {
  const regenerate = mock(async () => {})
  const sendMessage = mock(async () => {})
  const budgets: TurnBudget[] = []
  let onFinish: ChatOnFinishCallback<ThunderboltUIMessage> | undefined
  let onError: ((error: Error) => void) | undefined
  const wakeAdapterReconnect = mock(() => {})
  const trackEvent = mock((_eventName: EventType, _properties?: Record<string, unknown>) => {})

  const createTrackedTurnBudget = () => {
    const budget = createTurnBudget()
    budgets.push(budget)
    return budget
  }

  const createChat = (init: ChatInit<ThunderboltUIMessage>) => {
    onFinish = init.onFinish
    onError = init.onError
    return {
      id: init.id ?? sessionId,
      messages: init.messages ?? [],
      regenerate,
      sendMessage,
    } as unknown as Chat<ThunderboltUIMessage>
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
    selectedModel: {
      id: 'm1',
      model: 'claude-opus',
      provider: 'anthropic',
      apiKey: 'secret',
      isConfidential: 0,
    } as never,
    triggerData: null,
  })

  const finishWithError = (error?: Error) => {
    if (error) {
      onError?.(error)
    }
    return onFinish!({
      message: { id: 'failed-assistant', role: 'assistant', parts: [] },
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

  const getTurnBudget = () => budgets.at(-1)!

  return {
    finishSuccessfully,
    finishAborted,
    finishWithError,
    getTurnBudget,
    instance,
    regenerate,
    sendMessage,
    trackEvent,
    wakeAdapterReconnect,
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

  it('transitions connecting → ready when connectToAgent resolves', async () => {
    const observed: string[] = []
    const connectToAgent = mock(async (agent: Agent) => {
      observed.push(useChatStore.getState().sessions.get(sessionId)!.connectionStatus)
      return makeAdapter(agent)
    })

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
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
    resetStore()
    sessionStorage.clear()
  })

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

  it('tracks scalar model identifiers and one correlated success summary', async () => {
    const { finishSuccessfully, instance, trackEvent } = createRetryHarness()

    await instance.sendMessage({ text: 'new turn' })
    await finishSuccessfully()

    const sendCall = trackEvent.mock.calls.find(([event]) => event === 'chat_send_prompt')!
    const receiveCall = trackEvent.mock.calls.find(([event]) => event === 'chat_receive_reply')!
    const summaryCalls = trackEvent.mock.calls.filter(([event]) => event === 'chat_turn_completed')
    const sendProperties = sendCall[1] as Record<string, unknown>
    const receiveProperties = receiveCall[1] as Record<string, unknown>
    const summaryProperties = summaryCalls[0]![1] as Record<string, unknown>

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
        | Record<string, unknown>
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
      expect((autoRetry as Record<string, unknown>).trace_id).toBe((successSummary as Record<string, unknown>).trace_id)

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
      expect((retriesExhausted as Record<string, unknown>).trace_id).toBe(
        (errorSummary as Record<string, unknown>).trace_id,
      )
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
    const firstTrace = (sendCalls[0]![1] as Record<string, unknown>).trace_id
    const secondTrace = (sendCalls[1]![1] as Record<string, unknown>).trace_id
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
    const firstTrace = (sendCalls[0]![1] as Record<string, unknown>).trace_id
    const secondTrace = (sendCalls[1]![1] as Record<string, unknown>).trace_id
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
