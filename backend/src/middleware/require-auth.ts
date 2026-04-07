import type { Auth } from '@/auth/auth'
import { Elysia } from 'elysia'

const publicPathPrefixes = ['/v1/health', '/v1/api/auth/', '/v1/waitlist/', '/v1/posthog/']

const isPublicPath = (path: string) =>
  publicPathPrefixes.some((prefix) => {
    if (!prefix.endsWith('/')) return path === prefix
    return path.startsWith(prefix) || path === prefix.slice(0, -1)
  })

/**
 * Global middleware that enforces authentication on all non-public endpoints.
 * Public paths (health, Better Auth, waitlist) are always accessible.
 */
export const createRequireAuthMiddleware = (auth: Auth) =>
  new Elysia({ name: 'require-auth' })
    .onBeforeHandle(async ({ request }) => {
      const url = new URL(request.url)
      const path = url.pathname

      if (isPublicPath(path)) {
        return
      }

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
