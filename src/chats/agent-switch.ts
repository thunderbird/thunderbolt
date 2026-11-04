/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isPortableAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

/** A durable cloud conversation owns its execution environment and cannot inherit another agent's history. */
export const agentSwitchNeedsNewChat = (current: Agent, next: Agent, hasHistory: boolean): boolean =>
  hasHistory && current.id !== next.id && (isPortableAgent(current) || isPortableAgent(next))

/** Explicit agent selection survives navigation without mutating the source conversation. */
export const newChatForAgent = (agent: Agent): string => `/chats/new?${new URLSearchParams({ agent: agent.id })}`

/** Replace an explicit new-chat selection while retaining project and composer URL parameters. */
export const newChatSearchForAgent = (search: string, agent: Agent): string => {
  const params = new URLSearchParams(search)
  params.set('agent', agent.id)
  return `?${params}`
}
