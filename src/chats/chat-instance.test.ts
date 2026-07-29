/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `createAgentRoutingFetch` connection-status tests. Verifies the customFetch
 * factory writes `connectionStatus` transitions into the chat-store around
 * each call to the injected `connectToAgent`.
 */

import { createTurnBudget, maxRequestsPerTurn, type TurnBudget } from '@/ai/retry-budget'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
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
const createRetryHarness = () => {
  const regenerate = mock(async () => {})
  const sendMessage = mock(async () => {})
  const budgets: TurnBudget[] = []
  let onFinish: ChatOnFinishCallback<ThunderboltUIMessage> | undefined

  const createTrackedTurnBudget = () => {
    const budget = createTurnBudget()
    budgets.push(budget)
    return budget
  }

  const createChat = (init: ChatInit<ThunderboltUIMessage>) => {
    onFinish = init.onFinish
    return {
      id: init.id ?? sessionId,
      messages: init.messages ?? [],
      regenerate,
      sendMessage,
    } as unknown as Chat<ThunderboltUIMessage>
  }

  const instance = createChatInstance(sessionId, [], async () => {}, httpClient, getProxyFetch, {
    createChat,
    createTurnBudget: createTrackedTurnBudget,
  })
  hydrateStore({
    chatInstance: instance,
    chatThread: null,
    id: sessionId,
    selectedModel: { id: 'm1', isConfidential: 0 } as never,
    triggerData: null,
  })

  const finishWithError = () =>
    onFinish!({
      message: { id: 'failed-assistant', role: 'assistant', parts: [] },
      messages: [],
      isAbort: false,
      isDisconnect: false,
      isError: true,
    })

  const finishSuccessfully = () =>
    onFinish!({
      message: {
        id: 'successful-assistant',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done' }],
      },
      messages: [],
      isAbort: false,
      isDisconnect: false,
      isError: false,
    })

  const getTurnBudget = () => budgets.at(-1)!

  return { finishSuccessfully, finishWithError, getTurnBudget, instance, regenerate, sendMessage }
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
})

describe('createChatInstance — retry policy', () => {
  beforeEach(() => {
    resetStore()
  })

  afterEach(() => {
    resetStore()
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

  it('manual regenerate resets the turn budget', async () => {
    const { getTurnBudget, instance, regenerate } = createRetryHarness()
    const exhaustedBudget = exhaustTurnBudget(getTurnBudget())

    await instance.regenerate()

    expect(getTurnBudget()).not.toBe(exhaustedBudget)
    expect(getTurnBudget().probe.isExhausted).toBe(false)
    expect(getTurnBudget().consumer.tryConsumeRequest()).toBe(true)
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
})
