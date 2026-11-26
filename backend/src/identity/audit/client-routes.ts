/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type Auth, createAuthMacro } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createRateLimitConsumer } from '@/middleware/rate-limit'
import { Elysia, t } from 'elysia'
import { insertAuditEvent } from './write'

/** Client reports one user may send per hour. They are rare user actions, so this bounds storage. */
export const clientAuditEventBudget = { max: 60, durationSecs: 60 * 60 }

/** Ids and provider names only: a value shaped like this can't carry a URL or a key. */
const idPattern = '^[A-Za-z0-9._:-]+$'

const clientEventBody = t.Object(
  {
    action: t.Union([
      t.Literal('user_connection.added'),
      t.Literal('user_connection.updated'),
      t.Literal('user_connection.removed'),
      t.Literal('user_connection.credential_replaced'),
    ]),
    target: t.Object(
      {
        type: t.Union([t.Literal('provider_connection'), t.Literal('mcp_server'), t.Literal('integration')]),
        id: t.String({ minLength: 1, maxLength: 128, pattern: idPattern }),
      },
      { additionalProperties: false },
    ),
    provider: t.Optional(t.String({ minLength: 1, maxLength: 64, pattern: idPattern })),
    authMethod: t.Optional(t.Union([t.Literal('oauth'), t.Literal('api_key'), t.Literal('none')])),
  },
  { additionalProperties: false },
)

/**
 * `POST /audit/client-events`: changes to a user's own connections that happen only on the device
 * (MCP servers, provider credentials, integrations). Stored as `report_source = 'client'`: the
 * device's word, not something the server saw. The server sets the actor, the bound device and the
 * time; the client sends only the enums and ids above. Anonymous users are not members, so their
 * reports are accepted and dropped.
 */
export const createClientAuditRoutes = (auth: Auth, database: typeof DbType) => {
  const consume = createRateLimitConsumer(database, { enabled: true }, 'audit-client-event', clientAuditEventBudget)!
  return new Elysia({ name: 'client-audit-routes' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .post(
      '/audit/client-events',
      async ({ body, set, user, session }) => {
        if (user.isAnonymous) {
          set.status = 204
          return
        }
        const limited = await consume(`user:${user.id}`, set)
        if (limited) {
          return limited
        }
        await insertAuditEvent(database, {
          action: body.action,
          outcome: 'success',
          actor: { type: 'user', id: user.id },
          target: body.target,
          reportSource: 'client',
          metadata: {
            provider: body.provider ?? null,
            authMethod: body.authMethod ?? null,
            deviceId: session.deviceId ?? null,
          },
        })
        set.status = 204
      },
      { auth: true, body: clientEventBody },
    )
}
