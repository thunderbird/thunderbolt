/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { auditEvent, identityConnection, linkReview, scimUser, user } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { AdmissionError, type AdmissionErrorCode } from './admission-error'
import { getCurrentOrganizationId } from './current-organization'
import {
  approveLinkReview,
  type LinkReviewInput,
  listLinkReviews,
  recordLinkReview,
  rejectLinkReview,
} from './link-reviews'

describe('link review service', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>
  const actorId = 'admin-user'
  const candidateId = 'candidate-user'
  const connectionId = 'entra'
  const scimConnectionId = 'scim-entra'
  const scimActor = { actor: { type: 'scim_connection', id: connectionId }, credentialId: 'credential-1' } as const

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    await db.insert(user).values([
      { id: actorId, name: 'Admin', email: 'admin@corp.com', emailVerified: true },
      { id: candidateId, name: 'Ada', email: 'ada@corp.com', emailVerified: true },
    ])
    await db
      .insert(identityConnection)
      .values({ id: connectionId, orgId: getCurrentOrganizationId(), name: 'Entra', scimConnectionId })
  })

  afterEach(async () => {
    await cleanup()
  })

  const reviewFor = (externalId = 'oid-1'): LinkReviewInput => ({
    identityConnectionId: connectionId,
    trigger: 'scim_create_conflict',
    externalId,
    incomingEmail: 'ada@corp.com',
    incomingName: 'Ada Lovelace',
    candidateUserId: candidateId,
  })

  const eventsFor = (action: string) => db.select().from(auditEvent).where(eq(auditEvent.action, action))

  const expectRefused = async (attempt: Promise<unknown>, code: AdmissionErrorCode) => {
    const error = await attempt.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AdmissionError)
    expect((error as AdmissionError).code).toBe(code)
  }

  describe('recordLinkReview', () => {
    it('opens one pending review per identity, with one audit event, and counts retries on it', async () => {
      const first = await recordLinkReview(db, reviewFor(), scimActor)
      const second = await recordLinkReview(db, reviewFor(), scimActor)

      expect(second.id).toBe(first.id)
      expect(second).toMatchObject({ status: 'pending', attempts: 2, candidateUserId: candidateId })
      expect(second.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime())
      expect(await db.$count(linkReview)).toBe(1)
      const [created] = await eventsFor('link_review.created')
      expect(created).toMatchObject({
        actorType: 'scim_connection',
        actorId: connectionId,
        credentialId: 'credential-1',
        connectionId,
        targetType: 'link_review',
        targetId: first.id,
      })
      expect(await eventsFor('link_review.created')).toHaveLength(1)
    })

    it('leaves concurrent retries of one identity with a single row', async () => {
      await Promise.all([1, 2, 3].map(() => recordLinkReview(db, reviewFor(), scimActor)))

      const rows = await db.select().from(linkReview)
      expect(rows).toHaveLength(1)
      expect(rows[0].attempts).toBe(3)
    })

    it('keeps a rejection final: a retry bumps the rejected review and opens no new one', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)
      await rejectLinkReview(db, { reviewId: review.id, actorId })

      const retried = await recordLinkReview(db, reviewFor(), scimActor)

      expect(retried).toMatchObject({ id: review.id, status: 'rejected', attempts: 2 })
      expect(await db.$count(linkReview)).toBe(1)
    })
  })

  describe('approveLinkReview', () => {
    it('approves a pending review, recording who did it', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)

      const approved = await approveLinkReview(db, { reviewId: review.id, actorId })

      expect(approved).toMatchObject({ status: 'approved', resolvedBy: actorId })
      expect(approved.resolvedAt).toBeInstanceOf(Date)
      const [event] = await eventsFor('link_review.approved')
      expect(event).toMatchObject({
        outcome: 'success',
        actorType: 'user',
        actorId,
        targetId: review.id,
        connectionId,
        changes: { status: { from: 'pending', to: 'approved' } },
        metadata: { candidateUserId: candidateId },
      })
    })

    it('approves a rejected review, which a retry has bumped rather than replaced', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)
      await rejectLinkReview(db, { reviewId: review.id, actorId })
      await recordLinkReview(db, reviewFor(), scimActor)

      expect(await approveLinkReview(db, { reviewId: review.id, actorId })).toMatchObject({ status: 'approved' })
      expect(await db.$count(linkReview)).toBe(1)
    })

    it('refuses to approve a rejected review beside an open one for the same identity', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)
      await rejectLinkReview(db, { reviewId: review.id, actorId })
      await db.insert(linkReview).values({
        id: 'open-review',
        orgId: getCurrentOrganizationId(),
        ...reviewFor(),
        trigger: 'sso_sign_in',
        status: 'approved',
      })

      await expectRefused(approveLinkReview(db, { reviewId: review.id, actorId }), 'LINK_REVIEW_RESOLVED')
    })

    it("refuses the admin's own link", async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)

      await expectRefused(approveLinkReview(db, { reviewId: review.id, actorId: candidateId }), 'LINK_REVIEW_SELF')
      expect(await eventsFor('link_review.approved')).toHaveLength(0)
    })

    it('refuses while the candidate still has a SCIM user on that connection', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)
      const now = new Date()
      await db.insert(scimUser).values({
        id: 'old-record',
        connectionId: scimConnectionId,
        provisioningDomainId: getCurrentOrganizationId(),
        userId: candidateId,
        connectionUserKey: 'key-1',
        userName: 'ada',
        userNameKey: 'name-1',
        primaryEmail: 'ada@corp.com',
        workEmailValueIndex: 'ada@corp.com',
        emailValueIndex: 'ada@corp.com',
        displayName: 'Ada',
        formattedName: 'Ada',
        serializedEmails: '[]',
        externalId: 'old-uuid',
        active: false,
        orderKey: 'order-1',
        createdAt: now,
        updatedAt: now,
      })

      await expectRefused(approveLinkReview(db, { reviewId: review.id, actorId }), 'LINK_REVIEW_RECORD_EXISTS')
    })

    it('refuses an unknown or already-approved review', async () => {
      await expectRefused(approveLinkReview(db, { reviewId: 'missing', actorId }), 'LINK_REVIEW_NOT_FOUND')
      const review = await recordLinkReview(db, reviewFor(), scimActor)
      await approveLinkReview(db, { reviewId: review.id, actorId })

      await expectRefused(approveLinkReview(db, { reviewId: review.id, actorId }), 'LINK_REVIEW_RESOLVED')
    })
  })

  describe('rejectLinkReview', () => {
    it('rejects a pending review with its audit event, and nothing else', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)

      expect(await rejectLinkReview(db, { reviewId: review.id, actorId })).toMatchObject({
        status: 'rejected',
        resolvedBy: actorId,
      })
      expect(await eventsFor('link_review.rejected')).toHaveLength(1)
      await expectRefused(rejectLinkReview(db, { reviewId: review.id, actorId }), 'LINK_REVIEW_RESOLVED')
    })

    it('lets only one of two racing approvals win', async () => {
      const review = await recordLinkReview(db, reviewFor(), scimActor)

      const results = await Promise.allSettled([
        approveLinkReview(db, { reviewId: review.id, actorId }),
        approveLinkReview(db, { reviewId: review.id, actorId }),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(
        await db.$count(auditEvent, and(eq(auditEvent.targetId, review.id), eq(auditEvent.actorType, 'user'))),
      ).toBe(1)
    })
  })

  describe('listLinkReviews', () => {
    it('pages the org reviews, most recently attempted first, with the candidate and connection', async () => {
      const ids: string[] = []
      for (const [index, externalId] of ['a', 'b', 'c'].entries()) {
        const { id } = await recordLinkReview(db, reviewFor(externalId), scimActor)
        await db
          .update(linkReview)
          .set({ lastSeenAt: new Date(Date.UTC(2026, 10, 1, index)) })
          .where(eq(linkReview.id, id))
        ids.push(id)
      }
      // A retry moves the first review to the top.
      await recordLinkReview(db, reviewFor('a'), scimActor)

      const first = await listLinkReviews(db, { limit: 2 })
      const second = await listLinkReviews(db, { limit: 2, cursor: first.nextCursor! })

      expect(first.reviews.map((review) => review.id)).toEqual([ids[0], ids[2]])
      expect(first.reviews[0]).toMatchObject({
        candidate: { id: candidateId, email: 'ada@corp.com', name: 'Ada' },
        connection: { id: connectionId, name: 'Entra' },
      })
      expect(second.reviews.map((review) => review.id)).toEqual([ids[1]])
      expect(second.nextCursor).toBeNull()
    })

    it('filters by status and connection, and refuses a malformed cursor', async () => {
      const review = await recordLinkReview(db, reviewFor('a'), scimActor)
      await recordLinkReview(db, reviewFor('b'), scimActor)
      await rejectLinkReview(db, { reviewId: review.id, actorId })

      expect((await listLinkReviews(db, { status: 'rejected' })).reviews.map((row) => row.id)).toEqual([review.id])
      expect((await listLinkReviews(db, { connectionId: 'other' })).reviews).toEqual([])
      await expectRefused(listLinkReviews(db, { cursor: 'not-a-cursor' }), 'LINK_REVIEW_INVALID_CURSOR')
    })

    it("searches the incoming email and name and the candidate's, matching % and _ literally", async () => {
      const grace = await recordLinkReview(
        db,
        { ...reviewFor('g'), incomingEmail: 'grace_100%@gmail.com', incomingName: 'Grace Hopper' },
        scimActor,
      )
      const ada = await recordLinkReview(db, { ...reviewFor('a'), incomingName: null }, scimActor)
      const search = async (q: string) => (await listLinkReviews(db, { q })).reviews.map((review) => review.id).sort()

      expect(await search('HOPPER')).toEqual([grace.id])
      expect(await search('_100%')).toEqual([grace.id])
      expect(await search('100')).toEqual([grace.id])
      expect(await search('%')).toEqual([grace.id])
      // Both reviews link to Ada's account, by its email and its name.
      expect(await search('ada@corp')).toEqual([grace.id, ada.id].sort())
      expect(await search('Ada')).toEqual([grace.id, ada.id].sort())
      expect(await search('nobody')).toEqual([])
    })
  })
})
