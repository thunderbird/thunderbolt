/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { Elysia, t } from 'elysia'
import { getWsTicketStore, WsTicketStoreFullError, type WsTicketStore } from './ws-ticket-store'

/**
 * Mounts `POST /v1/ws-ticket`, the auth-via-subprotocol ticket exchange for
 * WebSocket endpoints (currently only `WS /v1/haystack/ws`).
 *
 * Flow:
 *  - Client (authenticated via session cookie or bearer token) POSTs `{ scope }`.
 *  - Server mints a short-lived single-use opaque nonce bound to (userId, scope).
 *  - Client opens the WebSocket with `['thunderbolt.v1', 'thunderbolt.ticket.<nonce>']`
 *    in `Sec-WebSocket-Protocol`. The server consumes the ticket inside
 *    `beforeHandle` and echoes only `thunderbolt.v1` back.
 *
 * Auth contract (mirrors `/v1/agents`):
 *  - Unauthenticated → 401.
 *  - Anonymous user → 403 with `ANONYMOUS_TICKET_FORBIDDEN`.
 *  - Authenticated regular user → 200 `{ ticket, expiresAt }`.
 *  - Body validation failure → 400.
 *  - Store at capacity → 503 (rare; DoS guard).
 */
export const createWsTicketRoutes = (auth: Auth, store: WsTicketStore = getWsTicketStore()) =>
  new Elysia({ name: 'ws-ticket-routes', prefix: '/ws-ticket' })
    .onError(safeErrorHandler)
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      const sessionUser = session?.user as User | undefined
      return { user: sessionUser ?? null }
    })
    .post(
      '/',
      ({ body, set, user }) => {
        if (!user) {
          set.status = 401
          return { error: 'Unauthorized' }
        }
        if (user.isAnonymous) {
          set.status = 403
          return { error: 'Forbidden', code: 'ANONYMOUS_TICKET_FORBIDDEN' }
        }

        const settings = getSettings()
        const ttlMs = settings.wsTicketTtlMs

        try {
          const ticket = store.issueTicket(user.id, body.scope, ttlMs)
          const expiresAt = Date.now() + ttlMs
          return { ticket, expiresAt }
        } catch (err) {
          if (err instanceof WsTicketStoreFullError) {
            set.status = 503
            return { error: 'ticket store at capacity', code: 'WS_TICKET_STORE_FULL' }
          }
          throw err
        }
      },
      {
        body: t.Object({
          // Enum is the future-proof shape: adding a new WS endpoint means
          // adding a literal here and a matching consumer call. A string would
          // open us up to silent scope mismatches.
          scope: t.Union([t.Literal('haystack'), t.Literal('proxy')]),
        }),
      },
    )
