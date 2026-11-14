/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { generateId } from '@better-auth/core/utils/id'
import { APIError, type BetterAuthPlugin, type DBAdapter } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import {
  type AccessDecision,
  type AccessRefusal,
  accessRefusalCodes,
  type AccessState,
  computeAccess,
  getAccess,
  loadAccessState,
  requiresSso,
} from './access'
import { admitAtSignIn } from './admission'
import { createAuditEvent } from './audit/write'
import { identityPluginSchema } from './plugin-schema'
import { didIdpDenyEmailVerified, getSsoConnection, otpSignInPath, passkeySignInPath, type SignInUser } from './sign-in'
import { recordFailedSignIn, signInEvent, signInFailureReason, signInPaths } from './sign-in-audit'

const getSessionPath = '/get-session'

/** Sign-in methods that skip the IdP, refused to a member who must sign in through SSO. */
const nonSsoSignInPaths = new Set([otpSignInPath, passkeySignInPath])

/**
 * The access check for a sign-in: `computeAccess`, then SSO only for a member an IdP with an SSO
 * side manages, so its MFA and conditional access always apply. Passkeys still unlock E2EE keys
 * after an SSO sign-in: that never reaches this check.
 */
export const decideSignIn = (state: AccessState, path: string | undefined): AccessDecision => {
  const access = computeAccess(state)
  return access.allowed && path !== undefined && nonSsoSignInPaths.has(path) && requiresSso(state)
    ? { allowed: false, reason: 'sso_required' }
    : access
}

type SignInUserRow = SignInUser & { isAnonymous: boolean | null }

type SessionResult = { user?: { id: string; isAnonymous?: boolean | null } } | null | undefined

/**
 * Organization identity for Better Auth. Declares the identity tables to the adapter, and
 * enforces membership:
 * - at sign-in, before any session is created: admit the user if a rule allows, then refuse a
 *   member without access (blocked, deprovisioned by their IdP, or with no live source), and an
 *   IdP-managed member signing in by email code or passkey instead of SSO
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
                    await admitAtSignIn(tx, {
                      user,
                      path: context?.path,
                      idpDeniedEmailVerified: await didIdpDenyEmailVerified(),
                      ssoConnection: await getSsoConnection(),
                    })
                    return decideSignIn(await loadAccessState(tx, user.id), context?.path)
                  })
                  if (access.allowed) {
                    if (!context?.path || !signInPaths.has(context.path)) {
                      return
                    }
                    // The success is written here, before the session, so no session ever exists
                    // without it; inside an SSO sign-in's transaction the two commit together. The
                    // session gets its id now so the event can name it.
                    const sessionId = context.context.generateId({ model: 'session' }) || generateId()
                    await createAuditEvent(
                      await getCurrentAdapter(adapter),
                      signInEvent({
                        outcome: 'success',
                        path: context.path,
                        headers: context.headers,
                        userId: user.id,
                        connectionId: (await getSsoConnection())?.id,
                        sessionId,
                      }),
                    )
                    return { data: { ...session, id: sessionId } }
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
          // Every failed sign-in. A refusal thrown by a before-hook never reaches here:
          // `refuseSignIn` records those.
          matcher: (ctx) => ctx.path !== undefined && signInPaths.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            // A success was recorded by the session hook, before the session was written.
            if (ctx.context.newSession) {
              return
            }
            const refusal = refusedSignIns.get(ctx.context)
            const reason = refusal
              ? accessRefusalCodes[refusal.reason]
              : signInFailureReason(ctx.path, ctx.context.returned)
            if (reason) {
              await recordFailedSignIn(rootAdapter, ctx, reason, refusal?.userId)
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
