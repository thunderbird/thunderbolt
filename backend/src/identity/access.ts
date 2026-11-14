/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { identityConnectionStatuses, membershipSourceKinds, membershipSourceStatuses } from '@/db/schema'
import type { DBTransactionAdapter } from 'better-auth'
import { getCurrentOrganizationId } from './current-organization'

/** The Better Auth adapter calls identity code makes; a transaction adapter fits too. */
export type AuthAdapter = Pick<DBTransactionAdapter, 'findOne' | 'findMany' | 'create' | 'update'>

export type MembershipRow = { id: string; orgId: string; userId: string; blockedAt: Date | null }

export type MembershipSourceRow = {
  id: string
  kind: (typeof membershipSourceKinds)[number]
  status: (typeof membershipSourceStatuses)[number]
  identityConnectionId: string | null
  ref: string | null
}

export type AccessState = {
  membership: MembershipRow | null
  sources: MembershipSourceRow[]
  /** Status of each connection a `scim` source names. */
  connectionStatusById: ReadonlyMap<string, (typeof identityConnectionStatuses)[number]>
}

export type AccessRefusal = 'not_member' | 'blocked' | 'deprovisioned' | 'no_live_source'

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessRefusal }

/** The error code a refused sign-in carries, per refusal. */
export const accessRefusalCodes: Record<AccessRefusal, string> = {
  not_member: 'ACCESS_NOT_MEMBER',
  blocked: 'ACCESS_BLOCKED',
  deprovisioned: 'ACCESS_DEPROVISIONED',
  no_live_source: 'ACCESS_NO_LIVE_SOURCE',
}

/**
 * Decide whether a member may get in, in this order:
 * 1. a local block refuses, whatever any IdP says
 * 2. while any IdP (SCIM) source manages the member, access follows those sources alone: at least
 *    one must be active, and invitations, domains and other local grants don't count
 * 3. otherwise any active source admits
 *
 * A `scim` source on a connection whose SCIM side is retiring or retired is ignored entirely: it
 * neither keeps the member in nor deprovisions them.
 */
export const computeAccess = ({ membership, sources, connectionStatusById }: AccessState): AccessDecision => {
  if (!membership) {
    return { allowed: false, reason: 'not_member' }
  }
  if (membership.blockedAt) {
    return { allowed: false, reason: 'blocked' }
  }
  const counted = sources.filter(
    (source) =>
      source.kind !== 'scim' ||
      (source.identityConnectionId !== null && connectionStatusById.get(source.identityConnectionId) === 'active'),
  )
  const idpSources = counted.filter((source) => source.kind === 'scim')
  if (idpSources.length > 0) {
    return idpSources.some((source) => source.status === 'active')
      ? { allowed: true }
      : { allowed: false, reason: 'deprovisioned' }
  }
  return counted.some((source) => source.status === 'active')
    ? { allowed: true }
    : { allowed: false, reason: 'no_live_source' }
}

/** Find the user's membership in the current org. */
export const findMembership = (adapter: AuthAdapter, userId: string, orgId = getCurrentOrganizationId()) =>
  adapter.findOne<MembershipRow>({
    model: 'orgMembership',
    where: [
      { field: 'orgId', value: orgId },
      { field: 'userId', value: userId },
    ],
  })

/**
 * Read what `computeAccess` needs through the Better Auth adapter. Inside a hook, pass
 * `getCurrentAdapter(...)` so the read joins the running transaction.
 */
export const loadAccessState = async (
  adapter: AuthAdapter,
  userId: string,
  orgId = getCurrentOrganizationId(),
): Promise<AccessState> => {
  const membership = await findMembership(adapter, userId, orgId)
  if (!membership) {
    return { membership: null, sources: [], connectionStatusById: new Map() }
  }
  const sources = await adapter.findMany<MembershipSourceRow>({
    model: 'membershipSource',
    where: [{ field: 'membershipId', value: membership.id }],
  })
  const connectionIds = [
    ...new Set(sources.flatMap((source) => (source.kind === 'scim' && source.identityConnectionId) || [])),
  ]
  const connections =
    connectionIds.length === 0
      ? []
      : await adapter.findMany<{ id: string; status: (typeof identityConnectionStatuses)[number] }>({
          model: 'identityConnection',
          where: [{ field: 'id', value: connectionIds, operator: 'in' }],
        })
  return {
    membership,
    sources,
    connectionStatusById: new Map(connections.map((connection) => [connection.id, connection.status])),
  }
}

/** Load and decide a user's access in the current org. */
export const getAccess = async (adapter: AuthAdapter, userId: string) =>
  computeAccess(await loadAccessState(adapter, userId))

/**
 * For routes that read a session row themselves instead of going through `auth.api.getSession`
 * (which already refuses members without access): true when the user may get in.
 */
export const hasAccess = async (auth: Auth, userId: string) =>
  (await getAccess((await auth.$context).adapter, userId)).allowed
