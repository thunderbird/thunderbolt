/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import { identityConnection, linkReview, scimUser, user } from '@/db/schema'
import { and, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm'
import type { AuthAdapter } from './access'
import { AdmissionError } from './admission-error'
import { type AuditEventInput, insertAuditEvent } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'

/*
 * The linking review queue: an incoming identity whose email an existing user owns, and that no
 * automatic or self-service tier may link, waits here for one admin. An approval does not link by
 * itself: the IdP's next attempt (a SCIM retry, or the next SSO sign-in) attaches to the user.
 */

export type LinkReviewRow = typeof linkReview.$inferSelect

export type LinkReviewStatus = LinkReviewRow['status']

export type LinkReviewInput = {
  identityConnectionId: string
  trigger: LinkReviewRow['trigger']
  externalId: string
  incomingEmail: string
  incomingName: string | null
  candidateUserId: string
}

/** The largest page `listLinkReviews` returns. */
export const linkReviewPageMaxSize = 100

const defaultPageSize = 50

type Cursor = { lastSeenAt: Date; id: string }

const encodeCursor = ({ lastSeenAt, id }: Cursor) =>
  Buffer.from(JSON.stringify([lastSeenAt.toISOString(), id])).toString('base64url')

const decodeCursor = (cursor: string): Cursor | null => {
  try {
    const [lastSeenAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string]
    const date = new Date(lastSeenAt)
    return typeof id === 'string' && !Number.isNaN(date.getTime()) ? { lastSeenAt: date, id } : null
  } catch {
    return null
  }
}

const reviewKey = ({
  identityConnectionId,
  externalId,
}: Pick<LinkReviewInput, 'identityConnectionId' | 'externalId'>) =>
  and(
    eq(linkReview.orgId, getCurrentOrganizationId()),
    eq(linkReview.identityConnectionId, identityConnectionId),
    eq(linkReview.externalId, externalId),
  )

/**
 * Record a refused link attempt, once it has been refused: outside the attempt's own transaction,
 * which rolls back. The first attempt opens a `pending` review and writes `link_review.created`;
 * later ones only bump `attempts` and `lastSeenAt`, so a retrying IdP leaves one row. A rejection
 * is final for the IdP: its retries bump the rejected review rather than opening a new one.
 */
export const recordLinkReview = (
  database: typeof DbType,
  input: LinkReviewInput,
  audit: Pick<AuditEventInput, 'actor' | 'credentialId'>,
) =>
  database.transaction(async (tx) => {
    const now = new Date()
    const [latest] = await tx
      .select()
      .from(linkReview)
      .where(reviewKey(input))
      .orderBy(desc(linkReview.createdAt))
      .limit(1)
    if (latest?.status === 'rejected') {
      const [bumped] = await tx
        .update(linkReview)
        .set({ attempts: sql`${linkReview.attempts} + 1`, lastSeenAt: now })
        .where(eq(linkReview.id, latest.id))
        .returning()
      return bumped
    }
    const [row] = await tx
      .insert(linkReview)
      .values({ id: crypto.randomUUID(), orgId: getCurrentOrganizationId(), ...input, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [linkReview.orgId, linkReview.identityConnectionId, linkReview.externalId],
        targetWhere: sql`${linkReview.status} in ('pending', 'approved')`,
        set: { attempts: sql`${linkReview.attempts} + 1`, lastSeenAt: now },
      })
      .returning()
    if (row.attempts === 1) {
      await insertAuditEvent(tx, {
        action: 'link_review.created',
        outcome: 'success',
        ...audit,
        target: { type: 'link_review', id: row.id },
        connectionId: input.identityConnectionId,
        metadata: { trigger: input.trigger, candidateUserId: input.candidateUserId },
      })
    }
    return row
  })

/** The approved review an incoming identity attaches through, read in the attempt's own transaction. */
export const findApprovedLinkReview = (
  adapter: Pick<AuthAdapter, 'findOne'>,
  { identityConnectionId, externalId }: Pick<LinkReviewInput, 'identityConnectionId' | 'externalId'>,
) =>
  adapter.findOne<LinkReviewRow>({
    model: 'linkReview',
    where: [
      { field: 'orgId', value: getCurrentOrganizationId() },
      { field: 'identityConnectionId', value: identityConnectionId },
      { field: 'externalId', value: externalId },
      { field: 'status', value: 'approved' },
    ],
  })

/** Mark an approved review as used, in the transaction that made the link. */
export const markLinkReviewLinked = (adapter: Pick<AuthAdapter, 'update'>, reviewId: string) =>
  adapter.update({ model: 'linkReview', where: [{ field: 'id', value: reviewId }], update: { status: 'linked' } })

/**
 * A page of the current org's reviews, most recently attempted first, with the candidate user and
 * the connection's name. Pass the previous page's `nextCursor` for the next one.
 */
export const listLinkReviews = async (
  database: QueryableDatabase,
  {
    status,
    connectionId,
    cursor,
    limit = defaultPageSize,
  }: { status?: LinkReviewStatus; connectionId?: string; cursor?: string; limit?: number } = {},
) => {
  const after = cursor ? decodeCursor(cursor) : null
  if (cursor && !after) {
    throw new AdmissionError('LINK_REVIEW_INVALID_CURSOR')
  }
  const pageSize = Math.min(Math.max(limit, 1), linkReviewPageMaxSize)
  const filters: (SQL | undefined)[] = [
    eq(linkReview.orgId, getCurrentOrganizationId()),
    status ? eq(linkReview.status, status) : undefined,
    connectionId ? eq(linkReview.identityConnectionId, connectionId) : undefined,
    after
      ? or(
          lt(linkReview.lastSeenAt, after.lastSeenAt),
          and(eq(linkReview.lastSeenAt, after.lastSeenAt), lt(linkReview.id, after.id)),
        )
      : undefined,
  ]
  const rows = await database
    .select({
      review: linkReview,
      candidate: { id: user.id, email: user.email, name: user.name },
      connection: { id: identityConnection.id, name: identityConnection.name },
    })
    .from(linkReview)
    .innerJoin(user, eq(user.id, linkReview.candidateUserId))
    .innerJoin(identityConnection, eq(identityConnection.id, linkReview.identityConnectionId))
    .where(and(...filters))
    .orderBy(desc(linkReview.lastSeenAt), desc(linkReview.id))
    .limit(pageSize + 1)

  const reviews = rows
    .slice(0, pageSize)
    .map(({ review, candidate, connection }) => ({ ...review, candidate, connection }))
  const last = reviews.at(-1)
  return { reviews, nextCursor: rows.length > pageSize && last ? encodeCursor(last) : null }
}

const getLinkReview = async (database: QueryableDatabase, reviewId: string) => {
  const [row] = await database
    .select()
    .from(linkReview)
    .where(and(eq(linkReview.orgId, getCurrentOrganizationId()), eq(linkReview.id, reviewId)))
  if (!row) {
    throw new AdmissionError('LINK_REVIEW_NOT_FOUND')
  }
  return row
}

/**
 * Whether the candidate still has a SCIM user on the review's connection. The plugin allows one per
 * connection and user, so the IdP's retry could not attach until the IdP deletes that record.
 */
const candidateHasScimUserOnConnection = async (database: QueryableDatabase, review: LinkReviewRow) => {
  const [row] = await database
    .select({ id: scimUser.id })
    .from(scimUser)
    .innerJoin(identityConnection, eq(identityConnection.scimConnectionId, scimUser.connectionId))
    .where(and(eq(identityConnection.id, review.identityConnectionId), eq(scimUser.userId, review.candidateUserId)))
    .limit(1)
  return row !== undefined
}

const hasOpenReview = async (database: QueryableDatabase, review: LinkReviewRow) => {
  const [open] = await database
    .select({ id: linkReview.id })
    .from(linkReview)
    .where(and(reviewKey(review), inArray(linkReview.status, ['pending', 'approved'])))
    .limit(1)
  return open !== undefined
}

/** Set a review's resolution, guarded on the statuses it may move from, with its audit event. */
const resolveLinkReview = (
  database: typeof DbType,
  review: LinkReviewRow,
  { to, from, actorId }: { to: 'approved' | 'rejected'; from: LinkReviewStatus[]; actorId: string },
) =>
  database.transaction(async (tx) => {
    const [updated] = await tx
      .update(linkReview)
      .set({ status: to, resolvedBy: actorId, resolvedAt: new Date() })
      .where(and(eq(linkReview.id, review.id), inArray(linkReview.status, from)))
      .returning()
    if (!updated) {
      throw new AdmissionError('LINK_REVIEW_RESOLVED')
    }
    await insertAuditEvent(tx, {
      action: to === 'approved' ? 'link_review.approved' : 'link_review.rejected',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'link_review', id: review.id },
      connectionId: review.identityConnectionId,
      changes: { status: { from: review.status, to } },
      metadata: { candidateUserId: review.candidateUserId },
    })
    return updated
  })

/**
 * Approve a link: the IdP's next attempt for this identity attaches to the candidate user. A
 * rejected review can still be approved. Refused for the admin's own account, which only tier 2's
 * proof of both identities may link, and while the candidate still has a SCIM user on that
 * connection, which the IdP must delete first.
 */
export const approveLinkReview = async (
  database: typeof DbType,
  { reviewId, actorId }: { reviewId: string; actorId: string },
) => {
  const review = await getLinkReview(database, reviewId)
  if (review.candidateUserId === actorId) {
    throw new AdmissionError('LINK_REVIEW_SELF')
  }
  if (review.status !== 'pending' && review.status !== 'rejected') {
    throw new AdmissionError('LINK_REVIEW_RESOLVED')
  }
  // Only one review per identity may be open, so a rejected one can't be approved beside another.
  if (review.status === 'rejected' && (await hasOpenReview(database, review))) {
    throw new AdmissionError('LINK_REVIEW_RESOLVED')
  }
  if (await candidateHasScimUserOnConnection(database, review)) {
    throw new AdmissionError('LINK_REVIEW_RECORD_EXISTS')
  }
  return resolveLinkReview(database, review, { to: 'approved', from: ['pending', 'rejected'], actorId })
}

/** Reject a pending link. The IdP's retries keep being refused, and the review stays visible. */
export const rejectLinkReview = async (
  database: typeof DbType,
  { reviewId, actorId }: { reviewId: string; actorId: string },
) => {
  const review = await getLinkReview(database, reviewId)
  if (review.status !== 'pending') {
    throw new AdmissionError('LINK_REVIEW_RESOLVED')
  }
  return resolveLinkReview(database, review, { to: 'rejected', from: ['pending'], actorId })
}
