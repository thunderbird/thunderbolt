/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type AnyColumn, sql } from 'drizzle-orm'
import { t } from 'elysia'

/** The largest page an admin list returns. */
export const adminPageMaxSize = 100

export const defaultAdminPageSize = 50

/** `limit` and `cursor`, for every paged admin list. */
export const pageQuery = {
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: adminPageMaxSize })),
  cursor: t.Optional(t.String({ maxLength: 1024 })),
}

/** A page boundary: the sort key of the page's last row, so pages stay stable while rows arrive. */
export const encodeCursor = (parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url')

/** The parts `encodeCursor` packed, or null when the cursor isn't one of ours. */
export const decodeCursor = (cursor: string, length: number): string[] | null => {
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown
    return Array.isArray(parts) && parts.length === length && parts.every((part) => typeof part === 'string')
      ? parts
      : null
  } catch {
    return null
  }
}

export type Page<T> = { items: T[]; nextCursor: string | null }

/** Trim the one extra row a query fetched to tell whether another page follows. */
export const toPage = <T>(rows: T[], limit: number, cursorOf: (row: T) => string[]): Page<T> => {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null }
}

/**
 * A timestamp column as Postgres text, to the microsecond. Postgres keeps microseconds and a JS
 * `Date` only milliseconds, so a cursor built from a `Date` would skip rows written within the same
 * millisecond as a page's last row.
 */
export const exactTimestamp = (column: AnyColumn) => sql<string>`${column}::text`

const exactTimestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/

/** The `[exactTimestamp, id]` a newest-first cursor packs, or null when the cursor isn't one of ours. */
export const decodeTimestampCursor = (cursor: string): [string, string] | null => {
  const [at, id] = decodeCursor(cursor, 2) ?? []
  return at && id && exactTimestampPattern.test(at) ? [at, id] : null
}

/** Rows after a newest-first cursor: strictly before it in `(timestamp, id)` order. */
export const beforeTimestampCursor = (timestamp: AnyColumn, id: AnyColumn, [at, cursorId]: [string, string]) =>
  sql`(${timestamp}, ${id}) < (${at}::timestamp, ${cursorId})`
