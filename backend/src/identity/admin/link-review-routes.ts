/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import { approveLinkReview, listLinkReviews, rejectLinkReview } from '../link-reviews'
import { pageQuery } from './pagination'
import { auditRefusals } from './route-helpers'

const id = t.String({ maxLength: 255 })
const reviewParams = t.Object({ reviewId: id })

/**
 * The linking review queue: identities no automatic or self-service tier could link, waiting for
 * one admin. The services audit what they resolve; refusals are recorded here.
 */
export const createLinkReviewAdminRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('link-review-admin-routes', auth, database)
    .get('/admin/link-reviews', ({ query }) => listLinkReviews(database, query), {
      query: t.Object({
        ...pageQuery,
        status: t.Optional(
          t.Union([t.Literal('pending'), t.Literal('approved'), t.Literal('rejected'), t.Literal('linked')]),
        ),
        connectionId: t.Optional(id),
      }),
    })
    .post(
      '/admin/link-reviews/:reviewId/approve',
      ({ params, user }) =>
        auditRefusals(
          database,
          { action: 'link_review.approved', actorId: user.id, target: { type: 'link_review', id: params.reviewId } },
          () => approveLinkReview(database, { reviewId: params.reviewId, actorId: user.id }),
        ),
      { params: reviewParams },
    )
    .post(
      '/admin/link-reviews/:reviewId/reject',
      ({ params, user }) =>
        auditRefusals(
          database,
          { action: 'link_review.rejected', actorId: user.id, target: { type: 'link_review', id: params.reviewId } },
          () => rejectLinkReview(database, { reviewId: params.reviewId, actorId: user.id }),
        ),
      { params: reviewParams },
    )
