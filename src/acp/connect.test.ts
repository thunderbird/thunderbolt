/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `connectToAgent` dispatch tests. Built-in path injects a stub for
 * `aiFetchStreamingResponse` via DI; ACP path injects a stub `openTransport`
 * + fake `ClientSideConnection` constructor.
 */

import '@/testing-library'

import { act } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import type {
  Agent as AcpSdkAgent,
  Client,
  InitializeRequest,
  NewSessionRequest,
  LoadSessionRequest,
  PromptRequest,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { connectToAgent } from './connect'

const builtInAgent: Agent = {
  id: 'built-in',
  name: 'Thunderbolt',
  type: 'built-in',
  transport: 'in-process',
  url: null,
  description: null,
  icon: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

const remoteAgent: Agent = {
  id: 'remote-foo',
  name: 'Foo',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.test/ws',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'u1',
}

const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn

const baseAdapterContext = (overrides: Partial<AgentAdapterContext> = {}): AgentAdapterContext => ({
  threadId: 't1',
  chatThread: null,
  acpSessionId: null,
  saveMessages: async () => {},
  selectedMode: { id: 'm', name: 'Default', systemPrompt: 'sys' } as AgentAdapterContext['selectedMode'],
  selectedModel: { id: 'mod-1' } as AgentAdapterContext['selectedModel'],
  mcpClients: [],
  httpClient,
  getProxyFetch,
  onAcpSessionId: async () => {},
  ...overrides,
})

describe('connectToAgent — built-in dispatch', () => {
  it('returns adapter whose fetch calls the injected aiFetch with correct args', async () => {
    const aiFetch = mock(async () => new Response('done'))
    const adapter = await connectToAgent(builtInAgent, { httpClient, getProxyFetch }, { aiFetch: aiFetch as never })

    expect(adapter.agent).toBe(builtInAgent)
    expect(adapter.capabilities).toBeNull()

    const init: RequestInit = { method: 'POST', body: '{}' }
    const ctx = baseAdapterContext({
      selectedMode: { id: 'm', name: 'CodeMode', systemPrompt: 'be helpful' } as AgentAdapterContext['selectedMode'],
      selectedModel: { id: 'gpt' } as AgentAdapterContext['selectedModel'],
    })
    await adapter.fetch(init, ctx)
    expect(aiFetch).toHaveBeenCalledTimes(1)
    const call = (aiFetch.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(call.modelId).toBe('gpt')
    expect(call.modeName).toBe('CodeMode')
    expect(call.modeSystemPrompt).toBe('be helpful')
    expect(call.init).toBe(init)
  })

  it('disconnect is a no-op for built-in', async () => {
    const adapter = await connectToAgent(
      builtInAgent,
      { httpClient, getProxyFetch },
      { aiFetch: (async () => new Response('ok')) as never },
    )
    expect(() => adapter.disconnect()).not.toThrow()
  })
})

// Fake transport + connection — exercises the dispatch + handshake without WS.
type ConnCalls = {
  initialize: InitializeRequest[]
  newSession: NewSessionRequest[]
  loadSession: LoadSessionRequest[]
  prompt: PromptRequest[]
}

const buildFakeAcpDeps = (opts: { capabilities?: { loadSession?: boolean }; newSessionId?: string }) => {
  const calls: ConnCalls = { initialize: [], newSession: [], loadSession: [], prompt: [] }
  const newId = opts.newSessionId ?? 'sess-new-1'

  class FakeConnection {
    constructor(
      _toClient: (agent: AcpSdkAgent) => Client,
      _stream: { writable: WritableStream; readable: ReadableStream },
    ) {}
    initialize = async (req: InitializeRequest) => {
      calls.initialize.push(req)
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: opts.capabilities?.loadSession ?? false },
      }
    }
    newSession = async (req: NewSessionRequest) => {
      calls.newSession.push(req)
      return { sessionId: newId }
    }
    loadSession = async (req: LoadSessionRequest) => {
      calls.loadSession.push(req)
      return {}
    }
    prompt = async (req: PromptRequest) => {
      calls.prompt.push(req)
      return { stopReason: 'end_turn' as const }
    }
  }

  const openTransport = async () => ({
    stream: {
      writable: new WritableStream(),
      readable: new ReadableStream(),
    },
    close: () => {},
  })

  return { calls, FakeConnection, openTransport }
}

describe('connectToAgent — remote-acp dispatch', () => {
  it('sends initialize, then newSession when no acpSessionId is present', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({})
    const onAcpSessionId = mock(async (_id: string) => {})

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch, acpSessionId: null, onAcpSessionId },
      { openTransport, ClientSideConnection: FakeConnection as never },
    )

    expect(calls.initialize).toHaveLength(1)
    expect(calls.newSession).toHaveLength(1)
    expect(calls.loadSession).toHaveLength(0)
    expect(adapter.capabilities).toMatchObject({ loadSession: false })
    expect(onAcpSessionId).toHaveBeenCalledWith('sess-new-1')
  })

  it('sends loadSession when acpSessionId present AND capabilities.loadSession is true', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({
      capabilities: { loadSession: true },
    })

    await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch, acpSessionId: 'existing-sess', onAcpSessionId: async () => {} },
      { openTransport, ClientSideConnection: FakeConnection as never },
    )

    expect(calls.newSession).toHaveLength(0)
    expect(calls.loadSession).toHaveLength(1)
    expect(calls.loadSession[0]).toMatchObject({ sessionId: 'existing-sess' })
  })

  it('falls back to newSession + onAcpSessionId callback when loadSession capability is false even if acpSessionId is set', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({
      capabilities: { loadSession: false },
      newSessionId: 'fresh-1',
    })
    const onAcpSessionId = mock(async (_id: string) => {})

    await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch, acpSessionId: 'old-stale', onAcpSessionId },
      { openTransport, ClientSideConnection: FakeConnection as never },
    )

    expect(calls.loadSession).toHaveLength(0)
    expect(calls.newSession).toHaveLength(1)
    expect(onAcpSessionId).toHaveBeenCalledWith('fresh-1')
  })

  it('fetch posts session/prompt with the last user-message text and returns a streaming Response', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({})

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch, acpSessionId: null, onAcpSessionId: async () => {} },
      { openTransport, ClientSideConnection: FakeConnection as never },
    )

    const init: RequestInit = {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'older' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
          { role: 'user', parts: [{ type: 'text', text: 'newest question' }] },
        ],
        id: 't1',
      }),
    }
    const ctx = baseAdapterContext()
    const response = await adapter.fetch(init, ctx)

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    // The prompt request fires inside the fetch IIFE — flush microtasks +
    // any throttle timers so the dispatch lands deterministically.
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0]).toMatchObject({
      sessionId: 'sess-new-1',
      prompt: [{ type: 'text', text: 'newest question' }],
    })
  })
})
