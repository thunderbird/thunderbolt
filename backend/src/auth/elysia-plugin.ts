import { Elysia } from 'elysia'
import { auth } from './auth'

/**
 * Better Auth plugin for Elysia
 * Mounts the auth handler and provides a macro for protected routes
 */
export const betterAuthPlugin = new Elysia({ name: 'better-auth' }).mount(auth.handler).macro({
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

export { auth }
