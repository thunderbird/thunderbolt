/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { extractClientIp } from '@/utils/request'
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { APIError, type BetterAuthPlugin, type DBAdapter } from 'better-auth'
import { createAuthMiddleware, isAPIError } from 'better-auth/api'
import { type AccessRefusal, accessRefusalCodes, computeAccess, getAccess, loadAccessState } from './access'
import { admitAtSignIn, otpSignInPath, type SignInUser, ssoSignInPaths } from './admission'
import { createAuditEvent } from './audit/write'
import { identityPluginSchema } from './plugin-schema'

const getSessionPath = '/get-session'

/** Paths that mint a session for a sign-in, where a refusal is recorded as a failed sign-in. */
const signInPaths = new Set([otpSignInPath, ...ssoSignInPaths, '/passkey/verify-authentication', '/device/token'])

type SignInUserRow = SignInUser & { isAnonymous: boolean | null }

type SessionResult = { user?: { id: string; isAnonymous?: boolean | null } } | null | undefined

/**
 * Organization identity for Better Auth. Declares the identity tables to the adapter, and
 * enforces membership:
 * - at sign-in, before any session is created: admit the user if a rule allows, then refuse a
 *   member without access (blocked, deprovisioned by their IdP, or with no live source)
 * - on every `getSession`, so a member who loses access reads as signed out on their next request
 *
 * Anonymous users are not members and pass through untouched. API keys skip the `getSession`
 * hooks, so `apiKeyOwnerHasAccess` guards them in the api-key plugin.
 */
export const identity = () => {
  let rootAdapter: DBAdapter
  // The refusal behind a failed sign-in, keyed on the request's auth context, so the endpoint's
  // after-hook can record it once the sign-in transaction has rolled back.
  const refusedSignIns = new WeakMap<object, { userId: string; reason: AccessRefusal }>()

  return {
    id: 'identity',
    schema: identityPluginSchema,
    init: (ctx) => {
      rootAdapter = ctx.adapter
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                before: async (session, context) => {
                  // Direct internalAdapter calls (tests) carry no endpoint context.
                  const adapter = context?.context.adapter ?? rootAdapter
                  const user = await (
                    await getCurrentAdapter(adapter)
                  ).findOne<SignInUserRow>({
                    model: 'user',
                    where: [{ field: 'id', value: session.userId }],
                  })
                  if (!user || user.isAnonymous) {
                    return
                  }
                  // Joins the sign-in's transaction when there is one (SSO), so admission commits
                  // or rolls back with the user and session; opens one otherwise.
                  const access = await runWithTransaction(adapter, async () => {
                    const tx = await getCurrentAdapter(adapter)
                    await admitAtSignIn(tx, { user, path: context?.path })
                    return computeAccess(await loadAccessState(tx, user.id))
                  })
                  if (access.allowed) {
                    return
                  }
                  if (context) {
                    refusedSignIns.set(context.context, { userId: user.id, reason: access.reason })
                  }
                  throw new APIError('FORBIDDEN', {
                    message: 'Access to this organization is not available',
                    code: accessRefusalCodes[access.reason],
                  })
                },
              },
            },
          },
        },
      }
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === getSessionPath,
          handler: createAuthMiddleware(async (ctx) => {
            const user = (ctx.context.returned as SessionResult)?.user
            if (!user || user.isAnonymous) {
              return
            }
            const access = await getAccess(rootAdapter, user.id)
            return access.allowed ? undefined : ctx.json(null)
          }),
        },
        {
          matcher: (ctx) => ctx.path !== undefined && signInPaths.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const refusal = refusedSignIns.get(ctx.context)
            if (!refusal || !isAPIError(ctx.context.returned)) {
              return
            }
            const headers = ctx.headers ?? new Headers()
            const clientIp = extractClientIp(headers, '', getSettings().trustedProxy)
            await createAuditEvent(rootAdapter, {
              action: 'auth.sign_in',
              outcome: 'failure',
              reason: accessRefusalCodes[refusal.reason],
              actor: { type: 'user', id: refusal.userId },
              target: { type: 'user', id: refusal.userId },
              metadata: { path: ctx.path },
              ipAddress: clientIp || null,
              userAgent: headers.get('user-agent'),
            })
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
