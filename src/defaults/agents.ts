/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'

/**
 * The built-in Thunderbolt agent. Lives in code only — never a DB row.
 *
 * The chat layer treats this special case as a thin adapter over the existing
 * `aiFetchStreamingResponse` pipeline; the ACP protocol is not involved.
 * Always present, always first in the agent list, never removable.
 */
export const builtInAgent: Agent = {
  id: 'thunderbolt-built-in',
  name: 'Thunderbolt',
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
