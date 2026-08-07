/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { verifyAgentInferenceToken } from '@/agents/inference-token'
import { getAgentDeployment, getUserById } from '@/dal'
import type { db as DbType } from '@/db/client'
import { APIError } from 'better-auth'
import { Elysia, type AnyElysia } from 'elysia'
import { type Auth, createAuth } from './auth'

/** Resolve a session while translating credential rejection into an unauthenticated result. */
export const resolveAuthSession = async (auth: Auth, headers: Headers) => {
  try {
    return await auth.api.getSession({ headers })
  } catch (error) {
    if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403)) {
      return null
    }

    throw error
  }
}

/**
 * Reusable auth macro plugin. Use with `{ auth: true }` on routes
 * to require authentication and get typed `user`/`session` on context.
 */
export const createAuthMacro = (auth: Auth) =>
  new Elysia({ name: 'auth-macro' }).macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await resolveAuthSession(auth, headers)

        if (!session?.user) {
          return status(401)
        }

        return {
          user: session.user,
          session: session.session,
        }
      },
    },
  })

/**
 * Auth macro that accepts EITHER a per-deployment agent inference token OR a
 * normal user session, resolving both to the owning user. Used by the inference
 * route so deployed sandbox agents can call managed models as their owner.
 *
 * Agent-first ordering is deliberate: a session token has the wrong `aud`, so
 * `verifyAgentInferenceToken` returns null and cleanly falls through to the
 * session path. `session` is null on the agent path (there is no browser session).
 */
export const createAgentOrUserAuthMacro = (auth: Auth, database: typeof DbType) =>
  new Elysia({ name: 'agent-or-user-auth-macro' }).macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const authHeader = headers.get('authorization')
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

        if (bearerToken) {
          const claims = await verifyAgentInferenceToken(bearerToken)
          if (claims) {
            const deployment = await getAgentDeployment(database, claims.deploymentId)
            if (!deployment || deployment.revokedAt != null) {
              return status(401)
            }

            const owner = await getUserById(database, claims.userId)
            if (!owner) {
              return status(401)
            }

            return { user: { id: claims.userId } }
          }
        }

        const session = await resolveAuthSession(auth, headers)
        if (!session?.user) {
          return status(401)
        }

        // Both success branches return the same `{ user: { id } }` shape: Elysia
        // collapses a resolve that returns differing object shapes to `never`.
        // The inference route only needs the owner id, not the session.
        return { user: { id: session.user.id } }
      },
    },
  })

/** Create a Better Auth plugin for Elysia with the provided database. */
export const createBetterAuthPlugin = (database: typeof DbType, ipRateLimit?: AnyElysia) => {
  const auth = createAuth(database)

  const plugin = new Elysia({ name: 'better-auth' })
  if (ipRateLimit) {
    plugin.use(ipRateLimit)
  }
  // Use .all() instead of .mount() — Elysia's mount() short-circuits the
  // request pipeline before onBeforeHandle, silently bypassing rate limiting.
  plugin.all('/*', ({ request }) => auth.handler(request), { parse: 'none' })

  return { plugin, auth }
}

export type { Auth }
