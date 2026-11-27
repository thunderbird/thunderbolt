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
  /** Status of each connection a `scim` or `sso` source names. */
  connectionStatusById: ReadonlyMap<string, (typeof identityConnectionStatuses)[number]>
  /** The connections a `scim` or `sso` source names that also have an SSO side. */
  ssoConnectionIds: ReadonlySet<string>
}

export type AccessRefusal = 'not_member' | 'blocked' | 'deprovisioned' | 'no_live_source' | 'sso_required'

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessRefusal }

/** The error code a refused sign-in carries, per refusal. */
export const accessRefusalCodes: Record<AccessRefusal, string> = {
  not_member: 'ACCESS_NOT_MEMBER',
  blocked: 'ACCESS_BLOCKED',
  deprovisioned: 'ACCESS_DEPROVISIONED',
  no_live_source: 'ACCESS_NO_LIVE_SOURCE',
  sso_required: 'ACCESS_SSO_REQUIRED',
}

/**
 * Whether a source counts: a SCIM source only while its connection's SCIM side is active, an SSO
 * source unless its connection is retired, and every other source.
 */
export const isCountedSource = (
  source: Pick<MembershipSourceRow, 'kind' | 'identityConnectionId'>,
  connectionStatusById: AccessState['connectionStatusById'],
) => {
  const connectionStatus = source.identityConnectionId ? connectionStatusById.get(source.identityConnectionId) : null
  if (source.kind === 'scim') {
    return connectionStatus === 'active'
  }
  return source.kind !== 'sso' || connectionStatus !== 'retired'
}

/** The member's `scim` sources that count, in any status: while there is one, an IdP manages them. */
export const idpManagingSources = ({ sources, connectionStatusById }: AccessState) =>
  sources.filter((source) => source.kind === 'scim' && isCountedSource(source, connectionStatusById))

/**
 * Whether an IdP manages the member: a SCIM source on a connection whose SCIM side is active, in any
 * status. A removed source counts too, until an admin detaches the link.
 */
export const isIdpManaged = (state: AccessState) => idpManagingSources(state).length > 0

/**
 * Whether the member may sign in only through SSO: an IdP manages them through a connection that has
 * an SSO side, so its MFA and conditional access apply. A connection with only a SCIM side has no
 * sign-in to send them to, so its members keep email code and passkeys.
 */
export const requiresSso = (state: AccessState) =>
  idpManagingSources(state).some(
    (source) => source.identityConnectionId !== null && state.ssoConnectionIds.has(source.identityConnectionId),
  )

/**
 * Decide whether a member may get in, in this order:
 * 1. a local block refuses, whatever any IdP says
 * 2. while any IdP (SCIM) source manages the member, access follows those sources alone: at least
 *    one must be active, and invitations, domains and other local grants don't count
 * 3. otherwise any active source admits
 *
 * A `scim` source on a connection whose SCIM side is retiring or retired, or an `sso` source on a
 * retired connection, is ignored entirely: it neither keeps the member in nor deprovisions them.
 */
export const computeAccess = (state: AccessState): AccessDecision => {
  const { membership, sources, connectionStatusById } = state
  if (!membership) {
    return { allowed: false, reason: 'not_member' }
  }
  if (membership.blockedAt) {
    return { allowed: false, reason: 'blocked' }
  }
  const counted = sources.filter((source) => isCountedSource(source, connectionStatusById))
  const idpSources = idpManagingSources(state)
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
    return { membership: null, sources: [], connectionStatusById: new Map(), ssoConnectionIds: new Set() }
  }
  const sources = await adapter.findMany<MembershipSourceRow>({
    model: 'membershipSource',
    where: [{ field: 'membershipId', value: membership.id }],
  })
  const connectionIds = [
    ...new Set(
      sources.flatMap(
        (source) => ((source.kind === 'scim' || source.kind === 'sso') && source.identityConnectionId) || [],
      ),
    ),
  ]
  const connections =
    connectionIds.length === 0
      ? []
      : await adapter.findMany<{
          id: string
          status: (typeof identityConnectionStatuses)[number]
          ssoProviderId: string | null
        }>({
          model: 'identityConnection',
          where: [{ field: 'id', value: connectionIds, operator: 'in' }],
        })
  return {
    membership,
    sources,
    connectionStatusById: new Map(connections.map((connection) => [connection.id, connection.status])),
    ssoConnectionIds: new Set(connections.flatMap((connection) => (connection.ssoProviderId ? connection.id : []))),
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

/**
 * For routes outside the auth hooks: true when an IdP manages the user, so the IdP, not the user,
 * decides when their account goes.
 */
export const isIdpManagedUser = async (auth: Auth, userId: string) =>
  isIdpManaged(await loadAccessState((await auth.$context).adapter, userId))
