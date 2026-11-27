/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deleteEnvelope } from '@/dal/encryption'
import type { db as DbType } from '@/db/client'
import type { membershipSourceStatuses } from '@/db/schema'
import {
  defineRequestState,
  hasRequestState,
  queueAfterTransactionHook,
  tryGetCurrentAuthEndpointContext,
} from '@better-auth/core/context'
import type { SCIMIdentity, SCIMIdentityState, SCIMTransactionContext } from '@better-auth/scim'
import type { DBTransactionAdapter } from 'better-auth'
import { type AuthAdapter, findMembership, getAccess, type MembershipSourceRow } from '../access'
import type { AuditAction } from '../audit/events'
import { createAuditEvent } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'
import { findApprovedLinkReview, markLinkReviewLinked, recordLinkReview } from '../link-reviews'
import {
  findLinkCandidate,
  hasRecordOnScimConnection,
  isDomainClaimedByConnection,
  type LinkTier,
  linkProfile,
} from '../linking'
import { addMembershipSource, createMembership } from '../membership'
import { getScimActor, type ScimActor, scimAuditEvent } from './actor'

/*
 * What a SCIM user change does to the member: their `scim` membership sources follow the plugin's
 * SCIM users, one source per connection, and a `DELETE` that ends their access revokes their
 * devices, sessions and API keys. Everything here runs in the plugin's transaction.
 */

type ScimSideConnection = { id: string; scimConnectionId: string | null; status: string }

type SourceStatus = (typeof membershipSourceStatuses)[number]

/** Better Auth's `findMany` returns 100 rows unless told otherwise; revocation must see them all. */
const allRows = 2147483647

const scimConnectionActor = (connectionId: string) => ({ type: 'scim_connection', id: connectionId }) as const

/**
 * Record a change attributed to the SCIM connection it concerns. The credential is added when the
 * change comes from that connection's own request; the decommission walk and a projection replay
 * have none.
 */
const recordScimLifecycleEvent = (
  adapter: AuthAdapter,
  actor: ScimActor | null,
  action: AuditAction,
  {
    connection,
    target,
    metadata,
  }: { connection: ScimSideConnection; target: { type: string; id: string }; metadata?: Record<string, unknown> },
) =>
  createAuditEvent(
    adapter,
    scimAuditEvent(action, {
      identityConnectionId: connection.id,
      credentialId: actor?.identityConnectionId === connection.id ? actor.credentialId : null,
      target,
      metadata,
    }),
  )

const findConnections = (adapter: Pick<AuthAdapter, 'findMany'>, field: 'id' | 'scimConnectionId', values: string[]) =>
  values.length === 0
    ? Promise.resolve([])
    : adapter.findMany<ScimSideConnection>({
        model: 'identityConnection',
        where: [
          { field: 'orgId', value: getCurrentOrganizationId() },
          { field, value: values, operator: 'in' },
        ],
      })

/** Only a connection whose SCIM side is live changes its members; a retiring side's sources are left alone. */
const isLiveScimSide = (connection: ScimSideConnection | undefined): connection is ScimSideConnection =>
  connection?.status === 'active' && connection.scimConnectionId !== null

/** The link `resolveUser` chose for this create, recorded by `reconcileUser` once the source exists. */
type ScimLink = {
  userId: string
  identityConnectionId: string
  tier: LinkTier
  reviewId?: string
}

const scimLinkState = defineRequestState<ScimLink | null>(() => null)

const takeScimLink = async () => ((await hasRequestState()) ? scimLinkState.get() : null)

/** Whether the current request is a PUT or PATCH of a SCIM user, the writes that change a profile. */
const isUserProfileWrite = () => {
  const endpoint = tryGetCurrentAuthEndpointContext()
  return endpoint?.path === '/scim/v2/Users/:userId' && (endpoint.method === 'PUT' || endpoint.method === 'PATCH')
}

/**
 * The plugin's `identity` callbacks. `database` is the app's Drizzle database, for the writes the
 * SCIM transaction can't hold: envelopes, deleted after it commits, and a link review, recorded
 * before a create that is about to be refused.
 */
export const createScimLifecycle = (database: typeof DbType) => {
  /**
   * End a member's access everywhere it outlives the membership: revoke every device (the same
   * columns `revokeDevice` sets) and delete their sessions and API keys, through the SCIM
   * transaction so it commits with the `DELETE`. Better Auth's session hooks don't see these
   * deletes, so each session's revocation is recorded here. Envelopes have no `id` column, so the
   * adapter can't reach them; they go right after the commit, and a revoked device is refused by
   * every envelope route meanwhile.
   */
  const revokeMemberCredentials = async (
    adapter: DBTransactionAdapter,
    userId: string,
    { actor, connection }: { actor: ScimActor | null; connection: ScimSideConnection },
  ) => {
    const byUser = [{ field: 'userId', value: userId }]
    // A device revoked earlier already lost its envelope with it.
    const live = [...byUser, { field: 'revokedAt', value: null }]
    const devices = await adapter.findMany<{ id: string }>({ model: 'device', where: live, limit: allRows })
    await adapter.updateMany({
      model: 'device',
      where: live,
      update: { revokedAt: new Date(), trusted: false, approvalPending: false, nodeId: null, nodeIdAttestedAt: null },
    })
    const sessions = await adapter.findMany<{ id: string }>({ model: 'session', where: byUser, limit: allRows })
    await adapter.deleteMany({ model: 'session', where: byUser })
    for (const session of sessions) {
      await recordScimLifecycleEvent(adapter, actor, 'auth.session_revoked', {
        connection,
        target: { type: 'user', id: userId },
        metadata: { sessionId: session.id },
      })
    }
    const apiKeys = await adapter.deleteMany({ model: 'apikey', where: [{ field: 'referenceId', value: userId }] })
    await queueAfterTransactionHook(
      async () => {
        for (const device of devices) {
          await deleteEnvelope(database, device.id, userId)
        }
      },
      { onError: (error) => console.error(`Deleting the envelopes of SCIM-deleted user ${userId} failed`, error) },
    )
    return { devices: devices.length, sessions: sessions.length, apiKeys }
  }

  /**
   * `identity.resolveUser` for a SCIM create, before the plugin's transaction. Links to an existing
   * user only through an approved review for this `externalId`, or when the email's domain is
   * verified and claimed by this connection (and the user never had a record on it). Any other
   * collision with an existing user's email opens a review and returns `create`, which the plugin
   * refuses with a 409: nothing reaches the existing user until an admin approves and the IdP
   * retries. Refuses a connection whose SCIM side is not live, which the token check should
   * already have done.
   */
  const resolveUser: NonNullable<SCIMIdentity['resolveUser']> = async (input, { database: adapter }) => {
    const [connection] = await findConnections(adapter, 'scimConnectionId', [input.connectionId])
    if (!isLiveScimSide(connection)) {
      throw new Error(`SCIM connection ${input.connectionId} has no live identity connection`)
    }
    const { externalId, primaryEmail, displayName } = input.resource
    const identityConnectionId = connection.id
    const approved = externalId ? await findApprovedLinkReview(adapter, { identityConnectionId, externalId }) : null
    if (approved) {
      await scimLinkState.set({
        userId: approved.candidateUserId,
        identityConnectionId,
        tier: 'review',
        reviewId: approved.id,
      })
      return {
        action: 'link',
        userId: approved.candidateUserId,
        profile: await linkProfile(adapter, approved.candidateUserId),
      }
    }
    const candidate = await findLinkCandidate(adapter, primaryEmail)
    if (!candidate) {
      return { action: 'create' }
    }
    if (
      (await isDomainClaimedByConnection(adapter, primaryEmail, identityConnectionId)) &&
      !(await hasRecordOnScimConnection(adapter, candidate.id, input.connectionId))
    ) {
      await scimLinkState.set({ userId: candidate.id, identityConnectionId, tier: 'domain' })
      return { action: 'link', userId: candidate.id, profile: await linkProfile(adapter, candidate.id) }
    }
    // The plugin requires `externalId` on create only through our pipeline; without one there is
    // nothing to key a review on, and the create is refused all the same.
    if (externalId) {
      const actor = await getScimActor(adapter)
      await recordLinkReview(
        database,
        {
          identityConnectionId,
          trigger: 'scim_create_conflict',
          externalId,
          incomingEmail: primaryEmail,
          incomingName: displayName || null,
          candidateUserId: candidate.id,
        },
        {
          actor: scimConnectionActor(identityConnectionId),
          credentialId: actor?.identityConnectionId === identityConnectionId ? actor.credentialId : null,
        },
      )
    }
    return { action: 'create' }
  }

  /** Record the link `resolveUser` chose, once the plugin has attached the new SCIM user to that user. */
  const recordScimLink = async (
    adapter: DBTransactionAdapter,
    actor: ScimActor | null,
    { userId, connection }: { userId: string; connection: ScimSideConnection },
  ) => {
    const link = await takeScimLink()
    if (!link || link.userId !== userId || link.identityConnectionId !== connection.id) {
      return
    }
    if (link.reviewId) {
      await markLinkReviewLinked(adapter, link.reviewId)
    }
    await recordScimLifecycleEvent(adapter, actor, 'link.created', {
      connection,
      target: { type: 'user', id: userId },
      metadata: { tier: link.tier, ...(link.reviewId ? { reviewId: link.reviewId } : {}) },
    })
  }

  /**
   * `identity.reconcileUser`, run in the transaction of every change to a user's SCIM records. The
   * plugin passes the resulting state, not the operation, so the change is read off our `scim`
   * sources: a SCIM user we have no source for was created, one whose `active` differs was
   * deactivated or reactivated, and a source whose SCIM user is gone was deleted. A PUT or PATCH
   * that changes none of that updated the profile. Only real changes write, so the plugin's domain
   * walks are no-ops.
   */
  const reconcileUser = async (
    { userId, sources }: SCIMIdentityState,
    { database: adapter }: SCIMTransactionContext,
  ) => {
    const actor = await getScimActor(adapter)
    const connectionByScimId = new Map(
      (
        await findConnections(
          adapter,
          'scimConnectionId',
          sources.map((source) => source.connectionId),
        )
      ).map((connection) => [connection.scimConnectionId, connection]),
    )
    const existingMembership = await findMembership(adapter, userId)
    const ours = existingMembership
      ? await adapter.findMany<MembershipSourceRow>({
          model: 'membershipSource',
          where: [
            { field: 'membershipId', value: existingMembership.id },
            { field: 'kind', value: 'scim' },
          ],
        })
      : []
    let membership = existingMembership
    const now = new Date()
    const target = { type: 'user', id: userId }
    const changed = new Set<string>()

    for (const source of sources) {
      // The plugin's domain walks reach every SCIM user in the org; only a live side of ours counts.
      const connection = connectionByScimId.get(source.connectionId)
      if (!isLiveScimSide(connection)) {
        continue
      }
      const status: SourceStatus = source.active ? 'active' : 'suspended'
      const row = ours.find((candidate) => candidate.identityConnectionId === connection.id)
      if (!row) {
        const admission = { kind: 'scim', ref: source.id, identityConnectionId: connection.id, status } as const
        if (membership) {
          await addMembershipSource(adapter, membership.id, admission)
          await recordScimLifecycleEvent(adapter, actor, 'member.source_added', {
            connection,
            target,
            metadata: { kind: 'scim' },
          })
        } else {
          membership = await createMembership(adapter, userId, admission, scimConnectionActor(connection.id))
        }
        await recordScimLifecycleEvent(adapter, actor, 'scim.user_created', {
          connection,
          target,
          metadata: { status },
        })
        await recordScimLink(adapter, actor, { userId, connection })
        changed.add(connection.id)
        continue
      }
      if (row.status === status && row.ref === source.id) {
        continue
      }
      await adapter.update({
        model: 'membershipSource',
        where: [{ field: 'id', value: row.id }],
        update: { status, ref: source.id, ...(row.status === status ? {} : { statusChangedAt: now }) },
      })
      if (row.status !== status) {
        await recordScimLifecycleEvent(
          adapter,
          actor,
          source.active ? 'scim.user_reactivated' : 'scim.user_deactivated',
          {
            connection,
            target,
            metadata: row.status === 'removed' ? { reprovisioned: true } : undefined,
          },
        )
        changed.add(connection.id)
      }
    }

    const writer =
      actor && [...connectionByScimId.values()].find((connection) => connection.id === actor.identityConnectionId)
    if (writer && isLiveScimSide(writer) && !changed.has(writer.id) && isUserProfileWrite()) {
      await recordScimLifecycleEvent(adapter, actor, 'scim.user_updated', { connection: writer, target })
    }

    const presentConnectionIds = new Set(
      sources.flatMap((source) => connectionByScimId.get(source.connectionId)?.id ?? []),
    )
    const deleted = ours.filter(
      (row) =>
        row.status !== 'removed' &&
        row.identityConnectionId !== null &&
        !presentConnectionIds.has(row.identityConnectionId),
    )
    const connectionById = new Map(
      (
        await findConnections(
          adapter,
          'id',
          deleted.flatMap((row) => row.identityConnectionId ?? []),
        )
      ).map((connection) => [connection.id, connection]),
    )
    const removed: ScimSideConnection[] = []
    for (const row of deleted) {
      const connection = connectionById.get(row.identityConnectionId ?? '')
      if (!isLiveScimSide(connection)) {
        continue
      }
      await adapter.update({
        model: 'membershipSource',
        where: [{ field: 'id', value: row.id }],
        update: { status: 'removed', statusChangedAt: now },
      })
      removed.push(connection)
    }
    if (removed.length === 0) {
      return
    }

    // Another IdP that still vouches for the member keeps their devices.
    const revoked = (await getAccess(adapter, userId)).allowed
      ? null
      : await revokeMemberCredentials(adapter, userId, { actor, connection: removed[removed.length - 1] })
    for (const connection of removed) {
      await recordScimLifecycleEvent(adapter, actor, 'scim.user_deleted', {
        connection,
        target,
        metadata: revoked ? { revoked } : undefined,
      })
    }
  }

  return { resolveUser, reconcileUser } satisfies SCIMIdentity
}
