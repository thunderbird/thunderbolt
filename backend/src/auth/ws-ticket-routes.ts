import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { type AnyElysia, Elysia } from 'elysia'
import { createWsTicket, TicketQuotaError } from './ws-ticket'

type RawPayload = { url?: string; authMethod?: string } | undefined

type RequestBody = { payload?: RawPayload }

type PayloadResult =
  | { ok: true; payload: Record<string, unknown> | undefined }
  | { ok: false; status: 400 | 403; error: string }

/** Parses an untrusted JSON request body, returning `null` on malformed input. */
const parseJsonBody = async (request: Request): Promise<RequestBody | null> => {
  try {
    return (await request.json()) as RequestBody
  } catch {
    return null
  }
}

/**
 * Validates and normalises the raw `payload` field from a ws-ticket request body.
 * Enforces URL protocol/size limits, authMethod size, and the `allowCustomAgents` flag.
 */
const buildTicketPayload = (raw: RawPayload): PayloadResult => {
  if (!raw || typeof raw.url !== 'string') {
    return { ok: true, payload: undefined }
  }

  if (!/^(wss?|https?):\/\//.test(raw.url) || raw.url.length > 2048) {
    return { ok: false, status: 400, error: 'Invalid or oversized URL' }
  }

  if (!getSettings().allowCustomAgents) {
    return { ok: false, status: 403, error: 'Custom agents are not allowed' }
  }

  const payload: Record<string, unknown> = { url: raw.url }
  if (typeof raw.authMethod === 'string') {
    if (raw.authMethod.length > 4096) {
      return { ok: false, status: 400, error: 'Oversized authMethod' }
    }
    payload.authMethod = raw.authMethod
  }

  return { ok: true, payload }
}

/**
 * Creates the WebSocket ticket endpoint.
 * POST /ws-ticket — returns a short-lived ticket for authenticating WebSocket connections.
 * Requires a valid session (cookie-based auth). Optionally IP rate-limited via `ipRateLimit`.
 */
export const createWsTicketRoutes = (auth: Auth, ipRateLimit?: AnyElysia) => {
  const app = new Elysia({ prefix: '/ws-ticket' }).onError(safeErrorHandler).use(createAuthMacro(auth))
  if (ipRateLimit) {
    app.use(ipRateLimit)
  }
  return app.post(
    '/',
    async ({ user, request, set }) => {
      const body = await parseJsonBody(request)
      if (body === null) {
        set.status = 400
        return { error: 'Invalid JSON body' }
      }

      const result = buildTicketPayload(body.payload)
      if (!result.ok) {
        set.status = result.status
        return { error: result.error }
      }

      try {
        const ticket = createWsTicket(user.id, result.payload)
        return { ticket }
      } catch (err) {
        if (err instanceof TicketQuotaError) {
          set.status = 429
          set.headers['Retry-After'] = String(err.retryAfterSecs)
          return { error: 'Ticket quota exceeded' }
        }
        throw err
      }
    },
    { auth: true },
  )
}
