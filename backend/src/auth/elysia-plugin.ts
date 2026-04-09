import { getSettings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import { withOriginValidation } from '@/middleware/origin-validation'
import { Elysia } from 'elysia'
import { type Auth, createAuth } from './auth'

/**
 * Reusable auth macro plugin. Use with `{ auth: true }` on routes
 * to require authentication and get typed `user`/`session` on context.
 */
export const createAuthMacro = (auth: Auth) =>
  new Elysia({ name: 'auth-macro' }).macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers })

        if (!session) {
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
 * Create a Better Auth plugin for Elysia with the provided database.
 * Defense-in-depth: Origin validation rejects unauthorized origins even if CORS is misconfigured.
 */
export const createBetterAuthPlugin = (database: typeof DbType) => {
  const auth = createAuth(database)
  const settings = getSettings()

  return {
    plugin: new Elysia({ name: 'better-auth' }).mount(withOriginValidation(auth.handler, settings)),
    auth,
  }
}

export type { Auth }
