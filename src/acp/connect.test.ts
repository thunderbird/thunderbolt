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
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { useConfigStore } from '@/api/config-store'
import { defaultSkillResearch, defaultSkillWeather } from '@/defaults/skills'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { skillsCapabilityMeta } from '@shared/agent-core/skills'
import type {
  Agent as AcpSdkAgent,
  Client,
  InitializeRequest,
  NewSessionRequest,
  LoadSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createSpyHttpClient } from '@/test-utils/http-client-spy'
import type { AiFetchStreamingResponseFn } from './built-in-adapter'
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
const isAgentActive = async () => true
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn

const baseAdapterContext = (overrides: Partial<AgentAdapterContext> = {}): AgentAdapterContext => ({
  threadId: 't1',
  chatThread: null,
  acpSessionId: null,
  saveMessages: async () => {},
  selectedModel: { id: 'mod-1' } as AgentAdapterContext['selectedModel'],
  mcpClients: [],
  reconnectClient: async () => null,
  httpClient,
  getProxyFetch,
  onAcpSessionId: async () => {},
  ...overrides,
})

describe('connectToAgent — built-in dispatch', () => {
  it('forwards request fields and an adapter-owned cancellation signal to the injected aiFetch', async () => {
    const aiFetch = mock<AiFetchStreamingResponseFn>(async () => new Response('done'))
    const adapter = await connectToAgent(builtInAgent, { httpClient, getProxyFetch }, { aiFetch })

    expect(adapter.agent).toBe(builtInAgent)
    expect(adapter.capabilities).toBeNull()

    const init: RequestInit = { method: 'POST', body: '{}' }
    const ctx = baseAdapterContext({
      selectedModel: { id: 'gpt' } as AgentAdapterContext['selectedModel'],
    })
    await adapter.fetch(init, ctx)
    expect(aiFetch).toHaveBeenCalledTimes(1)
    const call = aiFetch.mock.calls[0]![0]
    expect(call.modelId).toBe('gpt')
    expect(call.init).toEqual({ ...init, signal: expect.any(AbortSignal) })
    expect(call.init.signal?.aborted).toBe(false)

    adapter.disconnect()
    expect(call.init.signal?.aborted).toBe(true)
    expect(() => adapter.disconnect()).not.toThrow()
    await expect(adapter.fetch(init, ctx)).rejects.toThrow('aborted')
    expect(aiFetch).toHaveBeenCalledTimes(1)
  })
})

describe('connectToAgent: managed-http dispatch', () => {
  const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
  const originalPageUrl = window.location.href
  // The app always runs on a real origin; happy-dom's default `about:blank` has none.
  beforeEach(() => {
    window.location.href = 'https://app.example.com/chats/new'
  })
  afterEach(() => {
    window.location.href = originalPageUrl
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
  })

  const hostedAgent: Agent = {
    ...builtInAgent,
    id: 'hosted-agent',
    type: 'managed-http',
    transport: 'http',
    url: '/v1/agent/chat',
  }
  const refuseAcpTransport = () =>
    mock(async () => {
      throw new Error('managed-http must not open an ACP transport')
    })

  it('returns a handshake-free adapter that posts the turn through the context client', async () => {
    useLocalSettingsStore.setState({ cloudUrl: 'http://localhost:8000/v1' })
    const openTransport = refuseAcpTransport()
    const { httpClient: contextClient, fetchSpy } = createSpyHttpClient(async () => new Response('streamed'))

    const adapter = await connectToAgent(hostedAgent, { httpClient, getProxyFetch }, { openTransport, isAgentActive })
    const response = await adapter.fetch(promptInit('hi'), baseAdapterContext({ httpClient: contextClient }))

    expect(adapter.capabilities).toBeNull()
    expect(await response.text()).toBe('streamed')
    expect((fetchSpy.mock.calls[0]![0] as Request).url).toBe('http://localhost:8000/v1/agent/chat')
    expect(openTransport).not.toHaveBeenCalled()
  })

  it('refuses managed-http for a user-added agent, whose type syncs in plaintext', async () => {
    const openTransport = refuseAcpTransport()

    await expect(
      connectToAgent(
        { ...hostedAgent, isSystem: 0, userId: 'u1' },
        { httpClient, getProxyFetch },
        { openTransport, isAgentActive },
      ),
    ).rejects.toThrow('Refusing managed-http for non-system agent')
    expect(openTransport).not.toHaveBeenCalled()
  })
})

describe('connectToAgent: disabled or deleted agent', () => {
  it('refuses before opening a transport', async () => {
    const openTransport = mock(async () => {
      throw new Error('an inactive agent must not be dialed')
    })
    const refuse = mock(async () => false)

    await expect(
      connectToAgent(remoteAgent, { httpClient, getProxyFetch }, { openTransport, isAgentActive: refuse }),
    ).rejects.toThrow('"kind":"agent-unavailable"')
    expect(refuse).toHaveBeenCalledTimes(1)
    expect(openTransport).not.toHaveBeenCalled()
  })

  it('never checks a row for the built-in agent', async () => {
    const refuse = mock(async () => false)

    await connectToAgent(builtInAgent, { httpClient, getProxyFetch }, { aiFetch: mock(), isAgentActive: refuse })

    expect(refuse).not.toHaveBeenCalled()
  })
})

describe('connectToAgent: unknown agent type', () => {
  it('throws instead of falling through to ACP', async () => {
    const openTransport = mock(async () => {
      throw new Error('an unknown kind must not open an ACP transport')
    })
    const futureAgent = { ...remoteAgent, type: 'future-kind' } as unknown as Agent

    await expect(
      connectToAgent(futureAgent, { httpClient, getProxyFetch }, { openTransport, isAgentActive }),
    ).rejects.toThrow('Unknown agent type future-kind')
    expect(openTransport).not.toHaveBeenCalled()
  })
})

// Fake transport + connection — exercises the dispatch + handshake without WS.
type ConnCalls = {
  initialize: InitializeRequest[]
  newSession: NewSessionRequest[]
  loadSession: LoadSessionRequest[]
  resumeSession: ResumeSessionRequest[]
  prompt: PromptRequest[]
}

const buildFakeAcpDeps = (opts: {
  capabilities?: { loadSession?: boolean; resume?: boolean; skills?: boolean }
  newSessionId?: string
}) => {
  const calls: ConnCalls = { initialize: [], newSession: [], loadSession: [], resumeSession: [], prompt: [] }
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
        agentCapabilities: {
          loadSession: opts.capabilities?.loadSession ?? false,
          sessionCapabilities: opts.capabilities?.resume ? { resume: {} } : {},
          _meta: opts.capabilities?.skills ? skillsCapabilityMeta : undefined,
        },
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
    resumeSession = async (req: ResumeSessionRequest) => {
      calls.resumeSession.push(req)
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

/** Build a prompt-only request body the ACP adapter's `fetch` can parse. */
const promptInit = (text: string): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ id: 't1', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }),
})

describe('connectToAgent: skills in session metadata', () => {
  it.each([
    [false, true],
    [true, false],
  ])(
    'minimalMode %s: session/new carries user-invocable skills: %s, and widget contracts either way',
    async (minimalMode, userSkills) => {
      await setupTestDatabase()
      try {
        useConfigStore.setState({ config: { minimalMode } })
        const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({ capabilities: { skills: true } })
        const adapter = await connectToAgent(
          remoteAgent,
          { httpClient, getProxyFetch },
          { openTransport, ClientSideConnection: FakeConnection as never, isAgentActive },
        )
        await adapter.fetch(promptInit('hi'), baseAdapterContext({ acpSessionId: null }))

        const meta = JSON.stringify(calls.newSession[0]?._meta ?? {})
        expect(meta.includes(`"name":"${defaultSkillResearch.name}"`)).toBe(userSkills)
        expect(meta.includes(`"name":"${defaultSkillWeather.name}"`)).toBe(true)
      } finally {
        await teardownTestDatabase()
      }
    },
  )
})

describe('connectToAgent — remote-acp dispatch', () => {
  it('sends initialize at connect, then newSession on first fetch when no acpSessionId is present', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({})
    const onAcpSessionId = mock(async (_id: string) => {})

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch },
      { openTransport, ClientSideConnection: FakeConnection as never, getEnabledSkills: async () => [], isAgentActive },
    )

    // initialize runs at connect; session resolution is now lazy/per-thread.
    expect(calls.initialize).toHaveLength(1)
    expect(calls.newSession).toHaveLength(0)
    expect(adapter.capabilities).toMatchObject({ loadSession: false })

    await adapter.fetch(promptInit('hi'), baseAdapterContext({ acpSessionId: null, onAcpSessionId }))

    expect(calls.newSession).toHaveLength(1)
    expect(calls.loadSession).toHaveLength(0)
    expect(onAcpSessionId).toHaveBeenCalledWith('sess-new-1')
  })

  it('sends loadSession on fetch when acpSessionId present AND capabilities.loadSession is true', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({
      capabilities: { loadSession: true },
    })

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch },
      { openTransport, ClientSideConnection: FakeConnection as never, getEnabledSkills: async () => [], isAgentActive },
    )

    await adapter.fetch(promptInit('hi'), baseAdapterContext({ acpSessionId: 'existing-sess' }))

    expect(calls.newSession).toHaveLength(0)
    expect(calls.loadSession).toHaveLength(1)
    expect(calls.loadSession[0]).toMatchObject({ sessionId: 'existing-sess' })
  })

  it('sends resumeSession on fetch when acpSessionId present AND capabilities.resume is advertised', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({
      capabilities: { resume: true },
    })
    const onAcpSessionId = mock(async (_id: string) => {})

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch },
      { openTransport, ClientSideConnection: FakeConnection as never, getEnabledSkills: async () => [], isAgentActive },
    )
    expect(adapter.capabilities).toMatchObject({ resume: true })

    await adapter.fetch(promptInit('hi'), baseAdapterContext({ acpSessionId: 'existing-sess', onAcpSessionId }))

    expect(calls.resumeSession).toHaveLength(1)
    expect(calls.resumeSession[0]).toMatchObject({ sessionId: 'existing-sess' })
    expect(calls.newSession).toHaveLength(0)
    expect(calls.loadSession).toHaveLength(0)
    // resume reuses the existing id — nothing fresh to persist.
    expect(onAcpSessionId).not.toHaveBeenCalled()
  })

  it('falls back to newSession + onAcpSessionId callback when loadSession capability is false even if acpSessionId is set', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({
      capabilities: { loadSession: false },
      newSessionId: 'fresh-1',
    })
    const onAcpSessionId = mock(async (_id: string) => {})

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch },
      { openTransport, ClientSideConnection: FakeConnection as never, getEnabledSkills: async () => [], isAgentActive },
    )

    await adapter.fetch(promptInit('hi'), baseAdapterContext({ acpSessionId: 'old-stale', onAcpSessionId }))

    expect(calls.loadSession).toHaveLength(0)
    expect(calls.newSession).toHaveLength(1)
    expect(onAcpSessionId).toHaveBeenCalledWith('fresh-1')
  })

  it('fetch on a fresh session carrying prior history seeds the transcript ahead of the last user message', async () => {
    const { calls, FakeConnection, openTransport } = buildFakeAcpDeps({})

    const adapter = await connectToAgent(
      remoteAgent,
      { httpClient, getProxyFetch },
      { openTransport, ClientSideConnection: FakeConnection as never, getEnabledSkills: async () => [], isAgentActive },
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
    // acpSessionId is null → tier-3 newSession. The prior turns are seeded once so
    // the fresh agent isn't blind; the live prompt is still the last user message.
    const ctx = baseAdapterContext()
    const response = await adapter.fetch(init, ctx)

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    // The prompt request fires inside the fetch IIFE — flush microtasks +
    // any throttle timers so the dispatch lands deterministically.
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(calls.prompt).toHaveLength(1)
    expect(calls.prompt[0]?.sessionId).toBe('sess-new-1')
    const sent = (calls.prompt[0]?.prompt?.[0] as { type: string; text: string }).text
    expect(sent).toContain('Conversation so far:')
    expect(sent).toContain('user: older')
    expect(sent).toContain('assistant: reply')
    expect(sent.endsWith('newest question')).toBe(true)
  })
})
