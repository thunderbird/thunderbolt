/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { PreviewAgent, PreviewGroup, PreviewMember, PreviewState } from './data'

export type AgentAccessSource = { type: 'group'; group: PreviewGroup }

/** Resolve all effective grants against live groups and the member's current membership. */
export const getMemberAgentAccessSources = (
  agent: PreviewAgent,
  member: PreviewMember,
  state: PreviewState,
): AgentAccessSource[] => {
  if (agent.deletedAt !== null || !agent.enabled || member.deletedAt !== null) {
    return []
  }
  return state.groups
    .filter(
      (group) => group.deletedAt === null && agent.groupIds.includes(group.id) && member.groupIds.includes(group.id),
    )
    .map((group) => ({ type: 'group', group }))
}

/** Resolve an explicit grant against a live group and an enabled agent. */
export const getGroupAgentAccessSources = (agent: PreviewAgent, group: PreviewGroup): AgentAccessSource[] => {
  if (agent.deletedAt !== null || !agent.enabled || group.deletedAt !== null) {
    return []
  }
  return agent.groupIds.includes(group.id) ? [{ type: 'group', group }] : []
}

/** Only members of explicitly assigned live groups can use an agent. */
export const canMemberUseAgent = (agent: PreviewAgent, member: PreviewMember, state: PreviewState): boolean =>
  getMemberAgentAccessSources(agent, member, state).length > 0
