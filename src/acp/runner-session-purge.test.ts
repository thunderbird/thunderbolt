/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `purgeRunnerSession` — the runner-side erasure fired when a thread is deleted.
 *
 * Two properties matter more than the happy path. It must be precisely targeted
 * (only a built-in thread carrying a runner session should reach the wire, so an
 * ordinary agent's connection is never opened just to delete a thread), and it
 * must never reject — the local delete already happened, and a failed purge
 * cannot be allowed to surface as a failed delete.
 */

import '@/testing-library'

import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { setupConsoleSpy, type ConsoleSpies } from '@/test-utils/console-spies'
import type { Agent, AgentAdapter } from '@/types/acp'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runnerWireAgentId } from './runner-target'
import { purgeRunnerSession, type RunnerSessionPurgeDeps } from './runner-session-purge'

const context = {
  httpClient: {} as HttpClient,
  getProxyFetch: () => (async () => new Response('ok')) as unknown as FetchFn,
}

type Overrides = {
  runnerWsUrl?: string | null
  deleteRejects?: boolean
  /** Model a runner that never advertised `detachedTurns`: no delete seam. */
  omitDeleteSeam?: boolean
  connectFails?: boolean
}

const buildDeps = ({
  runnerWsUrl = 'wss://runner.test/ws',
  deleteRejects,
  omitDeleteSeam,
  connectFails,
}: Overrides = {}) => {
  const deleteSpy = mock(async (_sessionId: string) => {
    if (deleteRejects) {
      throw new Error('delete refused')
    }
  })
  const getRunnerWsUrl = mock(() => runnerWsUrl)
  const getOrConnectAdapter = mock(async (connected: Agent): Promise<AgentAdapter> => {
    if (connectFails) {
      throw new Error('transport down')
    }
    return {
      agent: connected,
      capabilities: null,
      fetch: async () => new Response('ok'),
      ensureSession: async () => {},
      ...(omitDeleteSeam ? {} : { deleteRunnerSession: deleteSpy }),
      disconnect: () => {},
    }
  })
  const deps: RunnerSessionPurgeDeps = { getRunnerWsUrl, getOrConnectAdapter }
  return { deps, deleteSpy, getOrConnectAdapter, getRunnerWsUrl }
}

const doomedThread = { agentId: builtInAgent.id, acpSessionId: 'sess-doomed' }

describe('purgeRunnerSession', () => {
  let consoleSpies: ConsoleSpies

  beforeEach(() => {
    consoleSpies = setupConsoleSpy()
  })

  afterEach(() => {
    consoleSpies.restore()
  })

  it('erases the session on the runner through a synthetic wire target', async () => {
    const { deps, deleteSpy, getOrConnectAdapter } = buildDeps()

    await purgeRunnerSession(doomedThread, context, deps)

    expect(deleteSpy).toHaveBeenCalledWith('sess-doomed')
    const target = getOrConnectAdapter.mock.calls[0]?.[0]
    expect(target?.id).toBe(runnerWireAgentId)
    expect(target?.url).toBe('wss://runner.test/ws')
  })

  it('does nothing for a built-in thread that never ran on the runner', async () => {
    const { deps, getOrConnectAdapter, getRunnerWsUrl } = buildDeps()

    await purgeRunnerSession({ agentId: builtInAgent.id, acpSessionId: null }, context, deps)

    expect(getRunnerWsUrl).not.toHaveBeenCalled()
    expect(getOrConnectAdapter).not.toHaveBeenCalled()
  })

  it('leaves a remote agent’s own session alone — that agent owns its retention', async () => {
    const { deps, getOrConnectAdapter } = buildDeps()

    await purgeRunnerSession({ agentId: 'custom-agent-1', acpSessionId: 'sess-x' }, context, deps)

    expect(getOrConnectAdapter).not.toHaveBeenCalled()
  })

  it('does nothing when the deployment no longer configures a runner', async () => {
    const { deps, getOrConnectAdapter } = buildDeps({ runnerWsUrl: null })

    await purgeRunnerSession(doomedThread, context, deps)

    expect(getOrConnectAdapter).not.toHaveBeenCalled()
  })

  it('is a no-op when the adapter has no delete seam', async () => {
    const { deps, deleteSpy } = buildDeps({ omitDeleteSeam: true })

    await purgeRunnerSession(doomedThread, context, deps)

    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('swallows and logs a connection failure', async () => {
    const { deps } = buildDeps({ connectFails: true })

    await purgeRunnerSession(doomedThread, context, deps)

    expect(consoleSpies.error).toHaveBeenCalledTimes(1)
  })

  it('swallows and logs a runner that refuses the delete', async () => {
    const { deps } = buildDeps({ deleteRejects: true })

    await purgeRunnerSession(doomedThread, context, deps)

    expect(consoleSpies.error).toHaveBeenCalledTimes(1)
  })
})
