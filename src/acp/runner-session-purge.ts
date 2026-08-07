/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectCloudRunnerWsUrl, useConfigStore } from '@/api/config-store'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { ChatThread } from '@/types'
import { getOrConnectAdapter as defaultGetOrConnectAdapter } from './adapter-cache'
import { buildRunnerWireTarget } from './runner-target'

export type RunnerSessionPurgeContext = {
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
}

/** DI seam so tests can drive the purge without a live transport or app config. */
export type RunnerSessionPurgeDeps = {
  getOrConnectAdapter?: typeof defaultGetOrConnectAdapter
  getRunnerWsUrl?: () => string | null
}

/**
 * Erase the cloud runner's state for a thread the user just deleted.
 *
 * Deleting a thread locally is a soft delete, but a runner session's server-side
 * state (session log, journal, workspace) has no such tombstone — leaving it
 * would let a deleted conversation outlive itself on our servers, so the remote
 * side is a hard delete by design.
 *
 * A built-in thread with an `acpSessionId` is the runner-owned marker, so callers
 * must capture the row BEFORE the soft delete scrubs its nullable columns. Never
 * rejects: a thread the user deleted stays deleted whatever the network does.
 */
export const purgeRunnerSession = async (
  thread: Pick<ChatThread, 'agentId' | 'acpSessionId'>,
  context: RunnerSessionPurgeContext,
  deps: RunnerSessionPurgeDeps = {},
): Promise<void> => {
  const { acpSessionId, agentId } = thread
  // A remote agent's session id belongs to that agent, which owns its own
  // retention; only the built-in agent's session id means "we put this on the
  // runner". Thread rows always persist their agent on creation.
  if (!acpSessionId || agentId !== builtInAgent.id) {
    return
  }
  const getRunnerWsUrl = deps.getRunnerWsUrl ?? (() => selectCloudRunnerWsUrl(useConfigStore.getState().config))
  const wsUrl = getRunnerWsUrl()
  if (!wsUrl) {
    return
  }
  const getOrConnectAdapter = deps.getOrConnectAdapter ?? defaultGetOrConnectAdapter
  try {
    const adapter = await getOrConnectAdapter(buildRunnerWireTarget(wsUrl), {
      httpClient: context.httpClient,
      getProxyFetch: context.getProxyFetch,
    })
    await adapter.deleteRunnerSession?.(acpSessionId)
  } catch (error) {
    console.error('Failed to erase runner session for deleted thread', error)
  }
}
