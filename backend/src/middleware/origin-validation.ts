import { getCorsOrigins, type Settings } from '@/config/settings'
import { Elysia } from 'elysia'

const isAllowed = (origin: string, allowedOrigins: (RegExp | string)[]) =>
  allowedOrigins.some((entry) => (entry instanceof RegExp ? entry.test(origin) : entry === origin))

/** Defense-in-depth: reject unauthorized origins even if CORS middleware is misconfigured. */
export const createOriginValidation = (settings: Pick<Settings, 'corsOrigins' | 'corsOriginRegex'>) => {
  const allowedOrigins = getCorsOrigins(settings)
  return new Elysia({ name: 'origin-validation' })
    .onBeforeHandle(({ request, set }) => {
      const origin = request.headers.get('origin')
      if (origin && !isAllowed(origin, allowedOrigins)) {
        set.status = 403
        return { error: 'Forbidden', code: 'ORIGIN_NOT_ALLOWED' }
      }
    })
    .as('scoped')
}

/** Wraps a web-standard handler with Origin validation — needed for .mount() which bypasses Elysia lifecycle hooks. */
export const withOriginValidation = (
  handler: (request: Request) => Response | Promise<Response>,
  settings: Pick<Settings, 'corsOrigins' | 'corsOriginRegex'>,
): ((request: Request) => Response | Promise<Response>) => {
  const allowedOrigins = getCorsOrigins(settings)
  return (request: Request) => {
    const origin = request.headers.get('origin')
    if (origin && !isAllowed(origin, allowedOrigins)) {
      return new Response(JSON.stringify({ error: 'Forbidden', code: 'ORIGIN_NOT_ALLOWED' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return handler(request)
  }
}
