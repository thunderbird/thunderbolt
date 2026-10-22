/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isPrivateAgent } from '@/defaults/agents'
import type { ChatThread } from '@/types'
import type { ChatStatus, UIMessage } from 'ai'
import type { Agent } from '@/types/acp'

/**
 * Whether sending this thread to `agent` would take a private chat off the
 * device in plaintext. A private chat (`isEncrypted` 1) is kept private by the
 * private agent's model policy; other agents receive history as is. This
 * remains a send guard for legacy or inconsistent synced data.
 */
export const exposesPrivateThread = (chatThread: ChatThread | null | undefined, agent: Agent): boolean =>
  chatThread?.isEncrypted === 1 && !isPrivateAgent(agent)

/**
 * Whether `useChatAutomation` is holding back this chat's unanswered last turn
 * because sending it would expose a private chat: the chat is idle on a
 * non-built-in agent and ends on a user message. The hook skips its auto-run on
 * it, and the composer shows a notice and holds the send while it holds, so a
 * typed message cannot carry the history out either.
 */
export const isPrivateAutoRunBlocked = ({
  chatThread,
  agent,
  status,
  stopping,
  lastRole,
}: {
  chatThread: ChatThread | null | undefined
  agent: Agent
  status: ChatStatus
  stopping: boolean
  lastRole: UIMessage['role'] | undefined
}): boolean => exposesPrivateThread(chatThread, agent) && status === 'ready' && !stopping && lastRole === 'user'
