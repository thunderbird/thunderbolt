/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { Availability } from '../../components/guarded-action'
import { adminRole, type AdminMember, type ConnectionStatus, type MemberRoleSource } from '@shared/admin-api'

type MemberSource = AdminMember['sources'][number]

export type ConnectionStatusById = ReadonlyMap<string, ConnectionStatus>

const available: Availability = { available: true }

/** An action that can't run, with the reason to show. */
const unavailable = (reason: MessageDescriptor): Availability => ({ available: false, reason })

/** Whether the member holds the admin role from any source. */
export const isAdmin = (member: AdminMember) => member.roles.some((source) => source.role === adminRole)

/**
 * Whether the member can still sign in when every identity provider is down: they have access and no
 * IdP requires SSO of them, so a SCIM-only connection leaves email-code sign-in open. The same rule
 * the backend's count of such admins uses.
 */
export const canSignInWithoutIdp = (member: AdminMember) => member.access.allowed && !member.requiresSso

/** Whether a role source is a direct grant (local or bootstrap) rather than a group's. */
const isAdminGrant = (source: MemberRoleSource) => source.from === 'local' || source.from === 'bootstrap'

/** The member's own grant of admin, local or bootstrap: the only kind a revoke removes. */
export const hasAdminGrant = (member: AdminMember) =>
  member.roles.some((source) => source.role === adminRole && isAdminGrant(source))

/** Whether every admin source the member has matches `isSource`, so losing those takes admin away. */
const holdsAdminOnlyThrough = (member: AdminMember, isSource: (source: MemberRoleSource) => boolean) => {
  const adminSources = member.roles.filter((source) => source.role === adminRole)
  return adminSources.length > 0 && adminSources.every(isSource)
}

/**
 * Whether removing the signed-in admin from a local group takes admin away from them: the group
 * maps to admin, and nothing else makes them one.
 */
export const isSelfDemotingGroupRemoval = (self: AdminMember, groupId: string) =>
  holdsAdminOnlyThrough(self, (source) => source.from === 'local_group' && source.groupId === groupId)

/**
 * Whether a save takes admin away from the signed-in admin editing themselves: revoking their own
 * grant and leaving local groups strips every admin source they have.
 */
export const isSelfDemotingEdit = (
  member: AdminMember,
  selfId: string | null,
  { revokesGrant, leftGroupIds }: { revokesGrant: boolean; leftGroupIds: string[] },
) =>
  member.userId === selfId &&
  (revokesGrant || leftGroupIds.length > 0) &&
  holdsAdminOnlyThrough(
    member,
    (source) =>
      (revokesGrant && isAdminGrant(source)) ||
      (source.from === 'local_group' && source.groupId !== undefined && leftGroupIds.includes(source.groupId)),
  )

/** Whether an IdP mirrors the member's name, so it would overwrite an edit. */
export const isNameIdpManaged = (member: AdminMember) => member.idpManaged?.fields.includes('name') ?? false

/** Whether the member can be blocked: anyone but yourself. */
export const getBlockState = (member: AdminMember, selfId: string | null): Availability =>
  member.userId === selfId ? unavailable(msg`You can't block yourself.`) : available

export type RevokeAdminState =
  | { available: true; confirmSelfDemotion: boolean }
  | { available: false; reason: MessageDescriptor }

/**
 * Revoking removes the member's own grant. Admin held only through a group stays until the group
 * changes, so there's nothing to revoke. Revoking your own last admin source needs a confirm,
 * because it takes the admin screens away from you.
 */
export const getRevokeAdminState = (member: AdminMember, selfId: string | null): RevokeAdminState => {
  if (!hasAdminGrant(member)) {
    return { available: false, reason: msg`Admin comes from a group. Change the group to take it away.` }
  }
  return {
    available: true,
    confirmSelfDemotion: member.userId === selfId && holdsAdminOnlyThrough(member, isAdminGrant),
  }
}

/**
 * Detach is offered on a member's SCIM link only. The IdP must have deleted the user, or the
 * connection's SCIM side must be retiring or retired; an unknown connection status counts as active.
 */
export const getDetachState = (
  source: MemberSource,
  member: AdminMember,
  selfId: string | null,
  connectionStatusById: ConnectionStatusById,
): Availability | null => {
  if (source.kind !== 'scim' || !source.connection) {
    return null
  }
  if (member.userId === selfId) {
    return unavailable(msg`You can't detach your own link.`)
  }
  const connectionActive = (connectionStatusById.get(source.connection.id) ?? 'active') === 'active'
  if (source.status === 'removed' || !connectionActive) {
    return available
  }
  return source.status === 'suspended'
    ? unavailable(msg`The identity provider only suspended them. Delete the user there first.`)
    : unavailable(msg`The identity provider still vouches for them. Remove them there first.`)
}

/**
 * Permanent deletion, for a member who has lost access. Null while they have access: the action
 * isn't offered at all. An IdP that only suspended them can still reactivate them.
 */
export const getPurgeState = (member: AdminMember, connectionStatusById: ConnectionStatusById): Availability | null => {
  if (member.access.allowed) {
    return null
  }
  const suspendedByIdp = member.sources.some(
    (source) =>
      source.kind === 'scim' &&
      source.status === 'suspended' &&
      source.connection !== null &&
      (connectionStatusById.get(source.connection.id) ?? 'active') === 'active',
  )
  return suspendedByIdp
    ? unavailable(msg`The identity provider can reactivate them. Delete the user there first.`)
    : available
}
