/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAppName } from '@/lib/branding-selectors'
import type { Agent } from '@/types/acp'

/**
 * The built-in agent. Lives in code only — never a DB row.
 *
 * The chat layer treats this special case as a thin adapter over the existing
 * `aiFetchStreamingResponse` pipeline; the ACP protocol is not involved.
 * Always present, always first in the agent list, never removable.
 *
 * It carries the deployment's app name, read on access so every list, picker
 * and fallback that holds this object shows the current branding. Only its id
 * is ever persisted, so the name is free to change.
 */
export const builtInAgent: Agent = {
  id: 'thunderbolt-built-in',
  get name() {
    return getAppName()
  },
  type: 'built-in',
  transport: 'in-process',
  url: null,
  description: 'Built-in AI assistant',
  icon: 'zap',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

/**
 * Whether an agent is the in-process built-in Thunderbolt agent (vs. an ACP
 * agent). Built-in-only chat affordances — the mode picker and the mode-aware
 * loading label — gate on this; ACP agents own their conversation mode upstream.
 */
export const isBuiltInAgent = (agent: Agent): boolean => agent.type === 'built-in'

/**
 * Whether an agent is the backend's hosted agent (`managed-http`). It runs on
 * the server with a model of its own, so the chat's selected model is unused,
 * the chat's content reaches the backend unencrypted (its threads are never
 * private), and it takes no attachments for now.
 */
export const isHostedAgent = (agent: Agent): boolean => agent.type === 'managed-http'
