/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Decide whether an `Agent` can be used on the current platform.
 *
 * Today every supported agent type (`built-in`, `remote-acp`, `managed-acp`,
 * `managed-http`) runs in any environment we ship to (web, Tauri desktop, Tauri mobile).
 * The seam exists so that when a future agent type ships requiring a native
 * shell (e.g. an `in-process` stdio runner) we can flip it off in the web
 * build without re-touching every UI surface that needs to disable composer
 * input.
 *
 * Inject `isTauri` for tests; production uses `@/lib/platform`.
 */

import { isTauri as defaultIsTauri } from '@/lib/platform'
import { isHostedAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

export type IsAgentAvailableDeps = {
  isTauri?: () => boolean
}

export const isAgentAvailable = (agent: Agent, deps: IsAgentAvailableDeps = {}): boolean => {
  const isTauri = deps.isTauri ?? defaultIsTauri

  // `in-process` transport on a non-`built-in` agent implies a desktop-only
  // local runner. The current schema doesn't ship such an agent, but the
  // guard means UIs that already read `isAgentAvailable` will react the
  // moment such an agent appears.
  if (agent.type !== 'built-in' && agent.transport === 'in-process') {
    return isTauri()
  }
  return true
}

/**
 * Whether the composer offers attachments for this agent. The hosted agent
 * (`managed-http`) takes none for now, so its composer hides the attach action
 * and ignores dropped and pasted files; any already in the chat's history are
 * replaced with a note by `src/acp/managed-http-adapter.ts`.
 */
export const agentAcceptsAttachments = (agent: Agent): boolean => !isHostedAgent(agent)
