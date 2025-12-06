import type { db as DbType } from '@/db/client'
import { Elysia } from 'elysia'
import { type Auth, createAuth } from './auth'

/**
 * Create a Better Auth plugin for Elysia with the provided database
 * This allows tests to inject their own database instance
 */
export const createBetterAuthPlugin = (database: typeof DbType) => {
  const auth = createAuth(database)

  return {
    plugin: new Elysia({ name: 'better-auth' }).mount(auth.handler).macro({
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
    }),
    auth,
  }
}

export type { Auth }
