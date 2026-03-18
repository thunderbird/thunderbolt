import type { Auth } from '@/auth/elysia-plugin'
import { getEncryptionSetup, upsertEncryptionSetup } from '@/dal'
import type { db as DbType } from '@/db/client'
import { Elysia } from 'elysia'

/**
 * Encryption API routes for canary + salt storage.
 * All routes require authentication.
 */
export const createEncryptionRoutes = (auth: Auth, database: typeof DbType) => {
  return new Elysia({ prefix: '/encryption' })
    .derive(async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers })

      if (!session) {
        set.status = 401
        return { user: null }
      }

      return { user: session.user }
    })
    .onBeforeHandle(({ user: sessionUser, set }) => {
      if (!sessionUser) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .post('/setup', async ({ body, user: sessionUser }) => {
      const userId = sessionUser!.id
      const { canary, salt } = body as {
        canary: { version: string; iv: string; ciphertext: string }
        salt?: string
      }

      await upsertEncryptionSetup(database, userId, canary, salt)

      return { success: true }
    })
    .get('/setup', async ({ user: sessionUser, set }) => {
      const userId = sessionUser!.id
      const setup = await getEncryptionSetup(database, userId)

      if (!setup) {
        set.status = 404
        return { error: 'No encryption setup found' }
      }

      return setup
    })
}
