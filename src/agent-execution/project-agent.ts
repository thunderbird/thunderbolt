/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'

export const projectAgentUnavailableMessage =
  "This agent cannot use the project's environment. Choose the built-in agent or move this chat out of the project."

/** ACP cwd identifies a directory on the remote agent, not this project's runtime.
 * Until an adapter can bind the actual selected environment, it must not bypass it. */
export const canUseProjectAgent = (agent: Pick<Agent, 'type'>): boolean => agent.type === 'built-in'

export class ProjectAgentUnavailableError extends Error {
  constructor() {
    super(projectAgentUnavailableMessage)
    this.name = 'ProjectAgentUnavailableError'
  }
}

export const isProjectAgentUnavailableError = (error?: Error | null): boolean =>
  error?.name === 'ProjectAgentUnavailableError' || error?.message === projectAgentUnavailableMessage

/** Enforced before connection, prompt, or compaction; existing selections remain untouched. */
export const assertProjectAgent = (agent: Pick<Agent, 'type'>, projectId?: string | null): void => {
  if (projectId && !canUseProjectAgent(agent)) {
    throw new ProjectAgentUnavailableError()
  }
}
