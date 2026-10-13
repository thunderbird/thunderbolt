/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { PreviewAgent, PreviewMember, PreviewState } from './data'

/** Effective access follows saved grants and live membership; an empty restricted list grants nobody access. */
export const canMemberUseAgent = (agent: PreviewAgent, member: PreviewMember, state: PreviewState): boolean => {
  if (agent.deletedAt !== null || !agent.enabled || member.deletedAt !== null) {
    return false
  }
  if (agent.accessMode === 'everyone') {
    return true
  }
  if (agent.accessMode === 'admins') {
    return member.role === 'admin'
  }
  if (agent.memberIds.includes(member.id)) {
    return true
  }
  return state.groups.some(
    (group) => group.deletedAt === null && agent.groupIds.includes(group.id) && member.groupIds.includes(group.id),
  )
}
