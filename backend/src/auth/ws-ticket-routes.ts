import { Elysia } from 'elysia'
import type { Auth } from './auth'
import { createWsTicket } from './ws-ticket'

/**
 * Creates the WebSocket ticket endpoint.
 * POST /ws-ticket — returns a short-lived ticket for authenticating WebSocket connections.
 * Requires a valid session (cookie-based auth).
 */
export const createWsTicketRoutes = (auth: Auth) => {
  const router = new Elysia({ prefix: '/ws-ticket' })

  router
    .derive(async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) {
        set.status = 401
        return { user: null }
      }
      return { user: session.user }
    })
    .onBeforeHandle(({ user, set }) => {
      if (!user) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .post('/', ({ user }) => {
      const ticket = createWsTicket(user!.id)
      return { ticket }
    })

  return router
}
