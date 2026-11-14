/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import type { db as DbType } from '@/db/client'
import { auditEvent } from '@/db/schema'
import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm'
import { t } from 'elysia'
import { createAdminRoutes } from '../admin-macro'
import { getCurrentOrganizationId } from '../current-organization'

/** The largest page the API returns. There is no export: reading the log in bulk is not offered. */
export const auditPageMaxSize = 100

const defaultPageSize = 50

type Cursor = { occurredAt: Date; id: string }

/** A page boundary: the last event's time and id, so pages stay stable while events arrive. */
const encodeCursor = ({ occurredAt, id }: Cursor) =>
  Buffer.from(JSON.stringify([occurredAt.toISOString(), id])).toString('base64url')

const decodeCursor = (cursor: string): Cursor | null => {
  try {
    const [occurredAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string]
    const date = new Date(occurredAt)
    return typeof id === 'string' && !Number.isNaN(date.getTime()) ? { occurredAt: date, id } : null
  } catch {
    return null
  }
}

const auditQuery = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: auditPageMaxSize })),
  cursor: t.Optional(t.String()),
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
 * audited.
 */
export const createAuditRoutes = (auth: Auth, database: typeof DbType) =>
  createAdminRoutes('audit-routes', auth, database).get(
    '/admin/audit-events',
    async ({ query, set }) => {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
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
      const limit = query.limit ?? defaultPageSize
      const rows = await database
        .select()
        .from(auditEvent)
        .where(and(...filters))
        .orderBy(desc(auditEvent.occurredAt), desc(auditEvent.id))
        .limit(limit + 1)

      const events = rows.slice(0, limit)
      const last = events.at(-1)
      return { events, nextCursor: rows.length > limit && last ? encodeCursor(last) : null }
    },
    { query: auditQuery },
  )
