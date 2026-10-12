/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Bot, Brain, Globe, MessageCircle, Server, Sparkles } from 'lucide-react'
import type { ComponentType } from 'react'

import { AppLogo } from '@/components/app-logo'
import type { Agent } from '@/types/acp'

/** Icons a deployment may name for its own agents through the descriptor's
 *  `icon` (e.g. `AGENT_ICON`). A fixed set, so a server-supplied name can only
 *  pick one of these and the bundle carries no icon it doesn't need. */
const systemAgentIcons = new Map<string, ComponentType<{ className?: string }>>([
  ['bot', Bot],
  ['brain', Brain],
  ['globe', Globe],
  ['message-circle', MessageCircle],
  ['server', Server],
  ['sparkles', Sparkles],
])

/** Visual icon for each agent flavor: built-in (app logo), system/managed
 *  (the icon the deployment named, else server), remote (globe). Shared by the
 *  Settings agent list and the chat header selector so the two stay
 *  perceptually consistent. */
export const iconForAgent = (agent: Agent): ComponentType<{ className?: string }> => {
  if (agent.type === 'built-in') {
    return AppLogo
  }
  if (agent.type === 'managed-acp' || agent.type === 'managed-http') {
    return (agent.icon && systemAgentIcons.get(agent.icon)) || Server
  }
  return Globe
}
