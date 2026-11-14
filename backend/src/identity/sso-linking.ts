/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isCliGrantSession } from '@/dal/sessions'
import type { db as DbType } from '@/db/client'
import { defineRequestState, hasRequestState, tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { BetterAuthPlugin, DBTransactionAdapter } from 'better-auth'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { getAccess } from './access'
import { type LinkReviewInput, recordLinkReview } from './link-reviews'
import { ssoSignInPaths } from './sign-in'

/*
 * The SSO side of linking: the self-service link request (tier 2), and the review an SSO sign-in
 * opens when it is refused (tier 3), written once the sign-in's transaction has rolled back.
 */

/**
 * The header that asks `/sign-in/sso` to link the identity it signs in with to the caller's own
 * account. A session alone never links: on a shared machine, whoever completes SSO in a browser
 * holding someone else's session would otherwise take over that account.
 */
export const linkIntentHeader = 'x-link-intent'

/** As long as the OIDC state or SAML RelayState the intent rides on. */
const linkIntentTtlMs = 10 * 60 * 1000

const linkIntentIdentifier = (state: string) => `sso-link:${state}`

/** The state the SSO flow carries across the IdP: OIDC `state`, or SAML `RelayState`. */
const flowStateOf = (url: string) => {
  const params = new URL(url).searchParams
  return params.get('state') ?? params.get('RelayState')
}

/**
 * Take the link request this SSO callback belongs to, if its sign-in started with one. Deleted in
 * the sign-in's transaction, so it links once; a refused sign-in keeps it until it expires. The
 * flow state is bound to the browser that started it (Better Auth's state cookie for OIDC, our
 * RelayState cookie for SAML), so the identity completing SSO is the one the account holder asked
 * to link.
 */
export const takeLinkIntent = async (adapter: Pick<DBTransactionAdapter, 'findOne' | 'delete'>) => {
  const endpoint = tryGetCurrentAuthEndpointContext()
  const query = endpoint?.query as { state?: unknown } | undefined
  const body = endpoint?.body as { RelayState?: unknown } | undefined
  const state = query?.state ?? body?.RelayState
  if (typeof state !== 'string' || state === '') {
    return null
  }
  const where = [{ field: 'identifier', value: linkIntentIdentifier(state) }]
  const intent = await adapter.findOne<{ value: string; expiresAt: Date }>({ model: 'verification', where })
  if (!intent) {
    return null
  }
  await adapter.delete({ model: 'verification', where })
  return intent.expiresAt > new Date() ? intent.value : null
}

const pendingReviewState = defineRequestState<LinkReviewInput | null>(() => null)

/** Ask for a review of this refused SSO sign-in, written after its transaction rolls back. */
export const requestSsoLinkReview = (review: LinkReviewInput) => pendingReviewState.set(review)

/**
 * Better Auth hooks for SSO linking. Records a link request on an explicit `/sign-in/sso` call from
 * a signed-in member, and writes the review a refused SSO sign-in asked for.
 */
export const ssoLinking = (database: typeof DbType) =>
  ({
    id: 'sso-linking',
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === '/sign-in/sso',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.headers?.get(linkIntentHeader) !== '1') {
              return
            }
            // API keys and CLI device grants are delegated, non-interactive credentials: a link made
            // through one would give whoever holds the key an interactive sign-in that outlives it.
            const refuseDelegated = () =>
              ctx.error('FORBIDDEN', { message: 'Linking a sign-in needs an interactive session' })
            if (ctx.headers.has('x-api-key')) {
              throw refuseDelegated()
            }
            const url = (ctx.context.returned as { url?: unknown } | undefined)?.url
            const state = typeof url === 'string' ? flowStateOf(url) : null
            const session = await getSessionFromCtx(ctx, { disableRefresh: true })
            const user = session?.user as { id: string; isAnonymous?: boolean | null } | undefined
            if (!state || !user || user.isAnonymous) {
              return
            }
            if (isCliGrantSession((session?.session as { deviceId?: string | null } | undefined)?.deviceId)) {
              throw refuseDelegated()
            }
            if (!(await getAccess(ctx.context.adapter, user.id)).allowed) {
              return
            }
            const now = new Date()
            await ctx.context.adapter.create({
              model: 'verification',
              data: {
                identifier: linkIntentIdentifier(state),
                value: user.id,
                expiresAt: new Date(now.getTime() + linkIntentTtlMs),
                createdAt: now,
                updatedAt: now,
              },
            })
          }),
        },
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
