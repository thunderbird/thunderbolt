/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { auditEvent } from '@/db/schema'
import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import { decodeCursor, defaultAdminPageSize, pageQuery, toPage } from '../admin/pagination'
import { getCurrentOrganizationId } from '../current-organization'

type Cursor = { occurredAt: Date; id: string }

const decodeAuditCursor = (cursor: string): Cursor | null => {
  const [occurredAt, id] = decodeCursor(cursor, 2) ?? []
  const date = new Date(occurredAt ?? '')
  return id && !Number.isNaN(date.getTime()) ? { occurredAt: date, id } : null
}

const auditQuery = t.Object({
  ...pageQuery,
  action: t.Optional(t.String()),
  outcome: t.Optional(t.Union([t.Literal('success'), t.Literal('failure'), t.Literal('denied')])),
  actorId: t.Optional(t.String()),
  targetType: t.Optional(t.String()),
  targetId: t.Optional(t.String()),
  connectionId: t.Optional(t.String()),
  from: t.Optional(t.Date()),
  to: t.Optional(t.Date()),
})

/**
 * The org's audit log for admins, newest first, one page at a time. Viewing a page is not itself
 * audited. There is no export: reading the log in bulk is not offered.
 */
export const createAuditRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('audit-routes', auth, database).get(
    '/admin/audit-events',
    async ({ query, set }) => {
      const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null
      if (query.cursor && !cursor) {
        set.status = 400
        return { code: 'INVALID_CURSOR' }
      }

      const filters: (SQL | undefined)[] = [
        eq(auditEvent.orgId, getCurrentOrganizationId()),
        query.action ? eq(auditEvent.action, query.action) : undefined,
        query.outcome ? eq(auditEvent.outcome, query.outcome) : undefined,
        query.actorId ? eq(auditEvent.actorId, query.actorId) : undefined,
        query.targetType ? eq(auditEvent.targetType, query.targetType) : undefined,
        query.targetId ? eq(auditEvent.targetId, query.targetId) : undefined,
        query.connectionId ? eq(auditEvent.connectionId, query.connectionId) : undefined,
        query.from ? gte(auditEvent.occurredAt, query.from) : undefined,
        query.to ? lte(auditEvent.occurredAt, query.to) : undefined,
        cursor
          ? or(
              lt(auditEvent.occurredAt, cursor.occurredAt),
              and(eq(auditEvent.occurredAt, cursor.occurredAt), lt(auditEvent.id, cursor.id)),
            )
          : undefined,
      ]
      const limit = query.limit ?? defaultAdminPageSize
      const rows = await database
        .select()
        .from(auditEvent)
        .where(and(...filters))
        .orderBy(desc(auditEvent.occurredAt), desc(auditEvent.id))
        .limit(limit + 1)

      const { items, nextCursor } = toPage(rows, limit, (event) => [event.occurredAt.toISOString(), event.id])
      return { events: items, nextCursor }
    },
    { query: auditQuery },
  )
