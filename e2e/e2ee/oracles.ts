/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Oracles for the E2EE red-team suite — the functions that answer "did the
 * attack succeed?" without a human reading prose.
 *
 * An oracle asserts on the **adversary's view** (what is visible in Postgres),
 * not on whether the app behaved. That inversion is the point: the correctness
 * specs already prove the feature works, and a broken E2EE scheme keeps working
 * perfectly while leaking.
 *
 * Two callers, one implementation: a frozen attack spec calls these from CI, and
 * an agent hunting live (see the `thunder-red-team` skill) calls them in a loop
 * to check itself. Claims are the C-ids in docs/architecture/e2ee-threat-model.md.
 *
 * These assume E2EE is ON for the account under test. With `E2EE_ENABLED=false`
 * every column is legitimately plaintext and `expectAllColumnsCiphertext` fails
 * by design.
 */

import { encPrefix, encryptedColumnsMap } from '../../shared/e2ee-types'
import { sql } from './db'

const powersyncSchema = 'powersync'
const valuePreviewLength = 120

/** One configured table+column pair that exists in the database. */
type EncryptedColumn = {
  table: string
  column: string
}

export type ColumnCoverage = {
  present: EncryptedColumn[]
  missing: EncryptedColumn[]
}

/**
 * Intersects `encryptedColumnsMap` with the live `powersync` schema.
 *
 * The scanners iterate the result rather than a hardcoded table list, so a
 * column added to the map is covered automatically — and a map entry with no
 * matching column surfaces as `missing` instead of being silently skipped.
 */
export const resolveEncryptedColumns = async (): Promise<ColumnCoverage> => {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = ${powersyncSchema}
  `
  const live = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))

  const configured = Object.entries(encryptedColumnsMap).flatMap(([table, columns]) =>
    columns.map((column) => ({ table, column })),
  )

  return {
    present: configured.filter(({ table, column }) => live.has(`${table}.${column}`)),
    missing: configured.filter(({ table, column }) => !live.has(`${table}.${column}`)),
  }
}

/**
 * Fails when `encryptedColumnsMap` names a table or column the server does not
 * have. A stale entry means the scanners below quietly stop covering it, so this
 * runs first in any spec that relies on them.
 */
export const expectEncryptedColumnsMapMatchesSchema = async (): Promise<void> => {
  const { missing } = await resolveEncryptedColumns()
  if (missing.length === 0) {
    return
  }
  const list = missing.map(({ table, column }) => `  ${table}.${column}`).join('\n')
  throw new Error(
    `encryptedColumnsMap names ${missing.length} column(s) absent from the ${powersyncSchema} schema.\n` +
      `Either the map is stale or the table is not synced; until it is fixed these columns are unscanned.\n${list}`,
  )
}

/**
 * Columns that `encryptedColumnsMap` claims are encrypted but that the BACKEND
 * writes directly, so the encode path never sees them and the stored value is
 * always plaintext.
 *
 * `devices.name`: the client sends its display name as the `X-Device-Name`
 * header (src/lib/http.ts, src/lib/auth-token.ts) and in the device-registration
 * body (src/services/encryption.ts), and the backend upserts it
 * (backend/src/dal/devices.ts). The map only governs the PowerSync upload
 * encoder and the sync middleware, so it has no reach into a REST-written
 * column, and there is no client-side write path for this one. Low direct
 * impact — the value is a user-agent-derived label the server necessarily reads
 * from the request anyway — but the map is meant to be the single source of
 * truth for what is encrypted, and here it is wrong.
 *
 * Anything added to this list is an accepted divergence and must be justified
 * here. Fixing one means deleting its entry, which is the point.
 */
export const serverAuthoredPlaintextColumns: readonly string[] = ['devices.name']

const preview = (value: string): string =>
  value.length <= valuePreviewLength ? value : `${value.slice(0, valuePreviewLength)}…`

const readColumn = async ({ table, column }: EncryptedColumn, userId?: string) =>
  userId === undefined
    ? await sql<{ id: string; user_id: string; value: string | null }[]>`
        SELECT id, user_id, ${sql(column)} AS value
        FROM powersync.${sql(table)}
      `
    : await sql<{ id: string; user_id: string; value: string | null }[]>`
        SELECT id, user_id, ${sql(column)} AS value
        FROM powersync.${sql(table)}
        WHERE user_id = ${userId}
      `

export type PlaintextHit = EncryptedColumn & {
  rowId: string
  userId: string
  marker: string
  value: string
}

/**
 * Searches every encrypted column on the server for known plaintext markers.
 *
 * Deliberately unscoped by user: a marker surfacing under *any* account is a
 * break, and one landing under a different account is a worse one than the leak
 * we were looking for.
 *
 * Markers must be distinctive enough not to occur by chance — seed user content
 * with a UUID rather than with a word.
 */
export const scanServerForPlaintext = async (markers: readonly string[]): Promise<PlaintextHit[]> => {
  if (markers.length === 0) {
    throw new Error('scanServerForPlaintext needs at least one marker; an empty scan always passes.')
  }

  const { present } = await resolveEncryptedColumns()
  const hits: PlaintextHit[] = []

  for (const target of present) {
    const rows = await readColumn(target)
    for (const row of rows) {
      if (row.value === null) {
        continue
      }
      for (const marker of markers) {
        if (row.value.includes(marker)) {
          hits.push({ ...target, rowId: row.id, userId: row.user_id, marker, value: preview(row.value) })
        }
      }
    }
  }

  return hits
}

/**
 * C1 (zero-knowledge server). Fails when user plaintext is readable in the
 * database — the single strongest signal that encryption was bypassed, and the
 * shape THU-429 had.
 */
export const expectNoPlaintextOnServer = async (markers: readonly string[]): Promise<void> => {
  const hits = await scanServerForPlaintext(markers)
  if (hits.length === 0) {
    return
  }
  const list = hits
    .map(
      (hit) =>
        `  ${hit.table}.${hit.column} row=${hit.rowId} user=${hit.userId} marker="${hit.marker}"\n    ${hit.value}`,
    )
    .join('\n')
  throw new Error(`C1 BROKEN — ${hits.length} plaintext value(s) readable on the server:\n${list}`)
}

export type UnencryptedValue = EncryptedColumn & {
  rowId: string
  value: string
}

/**
 * Every configured column that holds a value must be ciphertext. Complements the
 * marker scan: it needs no knowledge of what was written, so it catches a
 * write-through whose plaintext we never thought to look for.
 *
 * Scoped to one user, because a fixture account with encryption off would
 * otherwise fail it.
 */
export const findUnencryptedValues = async (userId: string): Promise<UnencryptedValue[]> => {
  const { present } = await resolveEncryptedColumns()
  const found: UnencryptedValue[] = []

  const scanned = present.filter(({ table, column }) => !serverAuthoredPlaintextColumns.includes(`${table}.${column}`))

  for (const target of scanned) {
    const rows = await readColumn(target, userId)
    for (const row of rows) {
      if (row.value === null || row.value === '' || row.value.startsWith(encPrefix)) {
        continue
      }
      found.push({ ...target, rowId: row.id, value: preview(row.value) })
    }
  }

  return found
}

/**
 * C1 (zero-knowledge server), blanket form. Fails on any configured column whose
 * stored value is not an `__enc:` payload.
 */
export const expectAllColumnsCiphertext = async (userId: string): Promise<void> => {
  const found = await findUnencryptedValues(userId)
  if (found.length === 0) {
    return
  }
  const list = found.map((row) => `  ${row.table}.${row.column} row=${row.rowId}\n    ${row.value}`).join('\n')
  throw new Error(`C1 BROKEN — ${found.length} configured column(s) hold non-ciphertext for user ${userId}:\n${list}`)
}
