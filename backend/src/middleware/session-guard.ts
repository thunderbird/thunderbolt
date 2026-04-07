import type { Auth } from '@/auth/elysia-plugin'
import { Elysia } from 'elysia'

/**
 * Shared session guard plugin. Derives the authenticated user from the
 * request session and rejects unauthenticated requests with 401.
 */
export const createSessionGuard = (auth: Auth) =>
  new Elysia()
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      return { user: session?.user ?? null }
    })
    .onBeforeHandle(({ user, set }) => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .as('scoped')
