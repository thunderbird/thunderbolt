/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'

import { getOrConnectAdapter as defaultGetOrConnectAdapter } from '@/acp/adapter-cache'
import { useHttpClient } from '@/contexts'
import { updateChatThread as defaultUpdateChatThread } from '@/dal/chat-threads'
import { getDb as defaultGetDb } from '@/db/database'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import type { ChatThread } from '@/types'
import type { Agent } from '@/types/acp'
import { makeCommandSink as defaultMakeCommandSink } from './chat-instance'

/** DI seam so tests can inject fakes for the external dependencies without
 *  `mock.module()` (which is global and would leak into unrelated suites).
 *  Production omits these and binds to the real module-level functions. */
export type WarmAcpCommandsDeps = {
  getOrConnectAdapter?: typeof defaultGetOrConnectAdapter
  updateChatThread?: typeof defaultUpdateChatThread
  makeCommandSink?: typeof defaultMakeCommandSink
  getDb?: typeof defaultGetDb
}

/**
 * Eagerly connect a non-built-in agent and warm its ACP session as soon as it's
 * selected for a thread, so the agent advertises its commands BEFORE the user's
 * first message. Without this the slash menu only fills after a send — the
 * connection (and thus the session whose `available_commands_update` carries the
 * command list) wasn't opened until the first prompt.
 *
 * The warmed session is cached per thread inside the adapter, so the first send
 * reuses it — no extra `session/new`. The commands sink matches the one the send
 * path wires (`chat-instance.ts`), so it doesn't matter which connect wins the
 * race for the shared per-agent connection. Built-in agents are skipped.
 *
 * Legitimate effect: it opens an external connection (an async on-select side
 * effect that can't be expressed in render). Re-warming is guarded to once per
 * (agent, thread); a failed warm clears the guard so a later render retries.
 */
export const useWarmAcpCommands = (
  session: {
    id: string
    selectedAgent: Agent
    chatThread: ChatThread | null
  },
  deps: WarmAcpCommandsDeps = {},
): void => {
  const { id, selectedAgent, chatThread } = session
  const getOrConnectAdapter = deps.getOrConnectAdapter ?? defaultGetOrConnectAdapter
  const updateChatThread = deps.updateChatThread ?? defaultUpdateChatThread
  const makeCommandSink = deps.makeCommandSink ?? defaultMakeCommandSink
  const getDb = deps.getDb ?? defaultGetDb
  const httpClient = useHttpClient()
  const getProxyFetch = useProxyFetchGetter()
  const warmedKey = useRef<string | null>(null)

  useEffect(() => {
    if (selectedAgent.type === 'built-in') {
      return
    }
    const key = `${selectedAgent.id}:${id}`
    if (warmedKey.current === key) {
      return
    }
    warmedKey.current = key

    let cancelled = false
    let warmed = false
    void (async () => {
      const adapter = await getOrConnectAdapter(selectedAgent, {
        httpClient,
        getProxyFetch,
        onAvailableCommands: makeCommandSink(selectedAgent.id),
      }).catch(() => null)

      if (!adapter) {
        if (!cancelled) {
          warmedKey.current = null
        }
        return
      }
      if (cancelled) {
        return
      }

      await adapter
        .ensureSession({
          threadId: id,
          acpSessionId: chatThread?.acpSessionId ?? null,
          onAcpSessionId: async (sessionId) => {
            if (chatThread?.workspaceId) {
              await updateChatThread(getDb(), chatThread.workspaceId, chatThread.id, { acpSessionId: sessionId })
            }
          },
        })
        .catch(() => {})
      warmed = true
    })()

    return () => {
      cancelled = true
      // If we tore down before the session finished warming, release the guard
      // so a remount with the same key retries instead of skipping forever.
      if (!warmed && warmedKey.current === key) {
        warmedKey.current = null
      }
    }
  }, [
    id,
    selectedAgent,
    chatThread,
    httpClient,
    getProxyFetch,
    getOrConnectAdapter,
    updateChatThread,
    makeCommandSink,
    getDb,
  ])
}
