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
    .post('/', async ({ user, request }) => {
      const body = (await request.json().catch(() => ({}))) as { payload?: { url?: string; authMethod?: string } }
      const raw = body.payload

      // Validate and cap payload to prevent memory abuse
      let payload: Record<string, unknown> | undefined
      if (raw && typeof raw.url === 'string' && /^(wss?|https?):\/\//.test(raw.url) && raw.url.length <= 2048) {
        payload = { url: raw.url }
        if (typeof raw.authMethod === 'string' && raw.authMethod.length <= 4096) {
          payload.authMethod = raw.authMethod
        }
      }

      const ticket = createWsTicket(user!.id, payload)
      return { ticket }
    })

  return router
}
