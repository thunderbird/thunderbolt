import type { db as DbType } from '@/db/client'
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

/** Endpoints whose JSON responses should have session tokens stripped. */
const redactedEndpoints = ['/get-session', '/list-sessions']

/**
 * Wrap a Better Auth handler to strip session tokens from response bodies.
 *
 * Defense-in-depth: if CORS is ever misconfigured, an attacker who can read
 * the response body won't get a portable bearer token they can use independently.
 *
 * Elysia's `.mount()` bypasses all lifecycle hooks (mapResponse, onAfterHandle, etc.),
 * so wrapping the handler itself is the only interception point.
 */
export const withSessionTokenRedacted = (
  handler: (request: Request) => Response | Promise<Response>,
): ((request: Request) => Promise<Response>) => {
  return async (request: Request): Promise<Response> => {
    const response = await handler(request)

    const path = new URL(request.url).pathname
    if (!redactedEndpoints.some((ep) => path.endsWith(ep))) {
      return response
    }

    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      return response
    }

    const body = await response.json()

    // get-session returns { session: { token, ... }, user: { ... } }
    if (body?.session?.token !== undefined) {
      delete body.session.token
    }

    // list-sessions returns [{ token, ... }, ...]
    if (Array.isArray(body)) {
      for (const session of body) {
        if (session?.token !== undefined) {
          delete session.token
        }
      }
    }

    const headers = new Headers(response.headers)
    headers.delete('content-length')

    return new Response(JSON.stringify(body), { status: response.status, headers })
  }
}

/**
 * Create a Better Auth plugin for Elysia with the provided database
 * This allows tests to inject their own database instance
 */
export const createBetterAuthPlugin = (database: typeof DbType) => {
  const auth = createAuth(database)

  return {
    plugin: new Elysia({ name: 'better-auth' }).mount(withSessionTokenRedacted(auth.handler)),
    auth,
  }
}

export type { Auth }
