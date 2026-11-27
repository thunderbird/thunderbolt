/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { defineRequestState, hasRequestState } from '@better-auth/core/context'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { type LinkReviewInput, recordLinkReview } from './link-reviews'
import { ssoSignInPaths } from './sign-in'

/*
 * The SSO side of linking: the review an SSO sign-in opens when it is refused, written once the
 * sign-in's transaction has rolled back.
 */

const pendingReviewState = defineRequestState<LinkReviewInput | null>(() => null)

/** Ask for a review of this refused SSO sign-in, written after its transaction rolls back. */
export const requestSsoLinkReview = (review: LinkReviewInput) => pendingReviewState.set(review)

/** Better Auth hook that writes the review a refused SSO sign-in asked for. */
export const ssoLinking = (database: typeof DbType) =>
  ({
    id: 'sso-linking',
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path !== undefined && ssoSignInPaths.includes(ctx.path),
          handler: createAuthMiddleware(async () => {
            const review = (await hasRequestState()) ? await pendingReviewState.get() : null
            if (review) {
              await recordLinkReview(database, review, { actor: { type: 'system' } })
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
