import type { Auth } from '@/auth/auth'
import type { Settings } from '@/config/settings'
import { Elysia } from 'elysia'

/** Paths that are always public (no auth required) */
const publicPathPrefixes = [
  '/v1/waitlist/', // Waitlist endpoints
  '/v1/health', // Health checks (exact match)
  '/v1/api/auth/', // Auth endpoints (handled by Better Auth)
]

/** Check if path matches a public prefix (with proper boundary checking) */
const isPublicPath = (path: string) =>
  publicPathPrefixes.some((prefix) => {
    // Exact match for paths without trailing slash (e.g., /v1/health)
    if (!prefix.endsWith('/')) return path === prefix
    // Prefix match for paths with trailing slash
    return path.startsWith(prefix) || path === prefix.slice(0, -1)
  })

/**
 * Middleware that enforces authentication when WAITLIST_ENABLED=true.
 * Public paths are always accessible regardless of this setting.
 */
export const createWaitlistAuthMiddleware = (settings: Settings, auth: Auth) =>
  new Elysia({ name: 'waitlist-auth' })
    .onBeforeHandle(async ({ request, set }) => {
      const url = new URL(request.url)
      const path = url.pathname

      // Always allow public paths
      if (isPublicPath(path) || !settings.waitlistEnabled) {
        return
      }

      // Waitlist enabled - require authentication
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) {
        set.status = 401
        return { error: 'Authentication required' }
      }

      return
    })
    .as('global')
