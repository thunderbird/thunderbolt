/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `useWarmAcpCommands` tests. The hook opens an ACP connection and warms a
 * session as soon as a non-built-in agent is selected, so the agent advertises
 * its commands before the first send. These tests cover the main paths:
 * built-in skip, warm-on-select, the once-per-(agent, thread) guard, fresh
 * session-id persistence, the failed-connect guard release, and re-warming
 * when the selected agent changes.
 *
 * External dependencies (adapter cache, DAL, command sink) are injected via the
 * hook's `deps` seam rather than `mock.module()` — those modules are imported
 * for real by many sibling suites, and Bun's module mocks are global, so a
 * module mock here would leak and break them.
 */

import '@/testing-library'

import { type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

import { HttpClientProvider } from '@/contexts'
import { ProxyFetchProvider } from '@/lib/proxy-fetch-context'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Agent, AgentAdapter, EnsureSessionContext } from '@/types/acp'
import type { ChatThread } from '@/types'
import { useWarmAcpCommands, type WarmAcpCommandsDeps } from './use-warm-acp-commands'

const httpClient = {} as HttpClient
const proxyFetch = (async () => new Response('ok')) as unknown as FetchFn

const getOrConnectAdapter = mock<NonNullable<WarmAcpCommandsDeps['getOrConnectAdapter']>>()
const ensureSession = mock<(ctx: EnsureSessionContext) => Promise<void>>(() => Promise.resolve())
const updateChatThread = mock<NonNullable<WarmAcpCommandsDeps['updateChatThread']>>(() => Promise.resolve())
const commandSink = mock()
const makeCommandSink = mock(() => commandSink) as unknown as WarmAcpCommandsDeps['makeCommandSink']
const fakeDb = {} as ReturnType<NonNullable<WarmAcpCommandsDeps['getDb']>>
const getDb = (() => fakeDb) as NonNullable<WarmAcpCommandsDeps['getDb']>

const deps: WarmAcpCommandsDeps = { getOrConnectAdapter, updateChatThread, makeCommandSink, getDb }

const makeAdapter = (agent: Agent): AgentAdapter => ({
  agent,
  capabilities: null,
  fetch: async () => new Response('ok'),
  ensureSession,
  disconnect: () => {},
})

const builtIn: Agent = {
  id: 'built-in',
  name: 'Built-in',
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

const remote: Agent = {
  ...builtIn,
  id: 'agent-1',
  name: 'Remote',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.test',
  isSystem: 0,
}

const thread: ChatThread = { id: 'thread-1', workspaceId: 'ws-1', acpSessionId: null } as ChatThread

const wrapper = ({ children }: { children: ReactNode }) => (
  <HttpClientProvider httpClient={httpClient}>
    <ProxyFetchProvider proxyFetch={proxyFetch}>{children}</ProxyFetchProvider>
  </HttpClientProvider>
)

const renderWarm = (props: { id: string; selectedAgent: Agent; chatThread: ChatThread | null }) =>
  renderHook((p) => useWarmAcpCommands(p, deps), { initialProps: props, wrapper })

/** Flush the hook's async on-select effect (connect → ensureSession → persist),
 *  draining queued microtasks and timers under the shared fake clock. */
const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

beforeEach(() => {
  getOrConnectAdapter.mockReset()
  ensureSession.mockReset()
  ensureSession.mockImplementation(() => Promise.resolve())
  updateChatThread.mockReset()
  updateChatThread.mockImplementation(() => Promise.resolve())
  commandSink.mockReset()
})

describe('useWarmAcpCommands', () => {
  it('skips built-in agents entirely', () => {
    renderWarm({ id: 'thread-1', selectedAgent: builtIn, chatThread: thread })
    expect(getOrConnectAdapter).not.toHaveBeenCalled()
  })

  it('connects and warms a session when a remote agent is selected', async () => {
    getOrConnectAdapter.mockResolvedValue(makeAdapter(remote))
    renderWarm({ id: 'thread-1', selectedAgent: remote, chatThread: thread })

    await flush()
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(getOrConnectAdapter).toHaveBeenCalledTimes(1)
    expect(getOrConnectAdapter.mock.calls[0]?.[0]).toBe(remote)
    expect(ensureSession.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread-1', acpSessionId: null })
  })

  it('does not re-warm on re-render for the same (agent, thread)', async () => {
    getOrConnectAdapter.mockResolvedValue(makeAdapter(remote))
    const { rerender } = renderWarm({ id: 'thread-1', selectedAgent: remote, chatThread: thread })

    await flush()
    expect(ensureSession).toHaveBeenCalledTimes(1)
    act(() => rerender({ id: 'thread-1', selectedAgent: remote, chatThread: thread }))
    await flush()

    // Same key — the guard prevents a second connect/warm.
    expect(getOrConnectAdapter).toHaveBeenCalledTimes(1)
    expect(ensureSession).toHaveBeenCalledTimes(1)
  })

  it('persists a fresh ACP session id via onAcpSessionId', async () => {
    ensureSession.mockImplementation(async (ctx) => {
      await ctx.onAcpSessionId('sess-new')
    })
    getOrConnectAdapter.mockResolvedValue(makeAdapter(remote))
    renderWarm({ id: 'thread-1', selectedAgent: remote, chatThread: thread })

    await flush()
    expect(updateChatThread).toHaveBeenCalledTimes(1)
    expect(updateChatThread.mock.calls[0]?.[1]).toBe('ws-1')
    expect(updateChatThread.mock.calls[0]?.[2]).toBe('thread-1')
    expect(updateChatThread.mock.calls[0]?.[3]).toEqual({ acpSessionId: 'sess-new' })
  })

  it('releases the guard on a failed connect so a later effect run retries', async () => {
    getOrConnectAdapter.mockRejectedValueOnce(new Error('connect failed')).mockResolvedValue(makeAdapter(remote))
    const { rerender } = renderWarm({ id: 'thread-1', selectedAgent: remote, chatThread: thread })

    await flush()
    expect(getOrConnectAdapter).toHaveBeenCalledTimes(1)
    expect(ensureSession).not.toHaveBeenCalled()

    // Re-run the effect (a dep changed) on the same instance: because the failed
    // connect cleared `warmedKey` instead of leaving it pinned, the same
    // (agent, thread) key is retried rather than skipped forever.
    const refreshed: ChatThread = { ...thread, acpSessionId: 'sess-existing' } as ChatThread
    act(() => rerender({ id: 'thread-1', selectedAgent: remote, chatThread: refreshed }))
    await flush()
    expect(getOrConnectAdapter).toHaveBeenCalledTimes(2)
    expect(ensureSession).toHaveBeenCalledTimes(1)
  })

  it('warms again when the selected agent changes', async () => {
    getOrConnectAdapter.mockResolvedValue(makeAdapter(remote))
    const { rerender } = renderWarm({ id: 'thread-1', selectedAgent: remote, chatThread: thread })
    await flush()
    expect(ensureSession).toHaveBeenCalledTimes(1)

    const other: Agent = { ...remote, id: 'agent-2', name: 'Other' }
    getOrConnectAdapter.mockResolvedValue(makeAdapter(other))
    act(() => rerender({ id: 'thread-1', selectedAgent: other, chatThread: thread }))
    await flush()

    expect(getOrConnectAdapter).toHaveBeenCalledTimes(2)
    expect(getOrConnectAdapter.mock.calls[1]?.[0]).toBe(other)
  })

  it('wires the per-agent command sink into the connect call', async () => {
    getOrConnectAdapter.mockResolvedValue(makeAdapter(remote))
    renderWarm({ id: 'thread-1', selectedAgent: remote, chatThread: thread })

    await flush()
    expect(getOrConnectAdapter).toHaveBeenCalledTimes(1)
    const ctx = getOrConnectAdapter.mock.calls[0]?.[1]
    expect(ctx?.onAvailableCommands).toBe(commandSink)
  })
})
