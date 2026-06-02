/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HandlerResult } from './types'

/** Column names Drizzle declares as `timestamp(...)`; JSON sends them as ISO strings. */
const timestampDbColumns = new Set(['deleted_at', 'last_seen', 'created_at', 'revoked_at', 'updated_at'])

/**
 * Map a `{ db_column_name: value }` payload from PowerSync into a Drizzle-ready
 * `{ schemaKey: value }` shape, dropping unknown columns and converting ISO date
 * strings on `timestamp` columns into `Date` instances.
 */
export const toSchemaRecord = (
  dbRecord: Record<string, unknown>,
  validDbNames: Set<string>,
  dbNameToKey: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [dbName, value] of Object.entries(dbRecord)) {
    if (!validDbNames.has(dbName)) {
      continue
    }
    const schemaKey = dbNameToKey[dbName]
    if (schemaKey && value !== undefined) {
      let mapped = value
      if (timestampDbColumns.has(dbName) && typeof value === 'string') {
        const d = new Date(value)
        mapped = Number.isNaN(d.getTime()) ? value : d
      }
      out[schemaKey] = mapped
    }
  }
  return out
}

/** Shorthand result constructors so handler bodies stay terse. */
export const allow = (): HandlerResult => ({ kind: 'apply' })
export const reject = (rejectionClass: 'permanent' | 'transient', code: string): HandlerResult => ({
  kind: 'reject',
  class: rejectionClass,
  code,
})
