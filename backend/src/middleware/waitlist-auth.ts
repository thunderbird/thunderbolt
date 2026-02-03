import type { Auth } from '@/auth/auth'
import type { Settings } from '@/config/settings'
import { Elysia } from 'elysia'

/** Paths that are always public (no auth required) */
const publicPathPrefixes = [
  '/v1/waitlist', // Waitlist endpoints
  '/v1/health', // Health checks
  '/v1/api/auth', // Auth endpoints (handled by Better Auth)
]

const isPublicPath = (path: string) => publicPathPrefixes.some((prefix) => path.startsWith(prefix))

/**
 * Middleware that enforces authentication when WAITLIST_ENABLED=true.
 * Public paths are always accessible regardless of this setting.
 */
export const createWaitlistAuthMiddleware = (settings: Settings, auth: Auth) =>
  new Elysia({ name: 'waitlist-auth' })
    .onBeforeHandle(async ({ request }) => {
      const url = new URL(request.url)
      const path = url.pathname

      // Always allow public paths
      if (isPublicPath(path) || !settings.waitlistEnabled) {
        return
      }

      // Waitlist enabled - require authentication
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return
    })
    .as('global')
