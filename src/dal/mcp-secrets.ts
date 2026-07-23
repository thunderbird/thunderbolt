/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { mcpSecretsTable } from '../db/tables'
import type { DrizzleQueryWithPromise } from '@/types'

export type McpCredentialSummary = {
  id: string
  type: 'bearer' | 'oauth'
  bearerToken?: string
}

/** Query all local MCP credentials without exposing the storage table to UI code. */
export const getMcpServerCredentialRows = (db: AnyDrizzleDatabase) => {
  const query = db.select().from(mcpSecretsTable)
  return query as typeof query & DrizzleQueryWithPromise<{ id: string; credentials: string | null }>
}

/** Converts a persisted credential row to the limited shape needed by settings UI. */
export const parseMcpCredentialSummary = (row: {
  id: string
  credentials: string | null
}): McpCredentialSummary | null => {
  if (!row.credentials) {
    return null
  }
  const credentials = JSON.parse(row.credentials) as McpServerCredentials
  return credentials.type === 'bearer'
    ? { id: row.id, type: 'bearer', bearerToken: credentials.token }
    : { id: row.id, type: 'oauth' }
}

/** Credential blob stored on-device for an MCP server. Forward-supports OAuth token sets. */
export type McpServerCredentials =
  | { type: 'bearer'; token: string }
  | {
      type: 'oauth'
      access_token: string
      refresh_token?: string
      expires_at?: number // epoch ms
      clientId?: string // DCR-issued client_id (per-AS); absent for CIMD
      issuer?: string // AS issuer (per-AS binding)
      tokenEndpoint?: string // discovered token endpoint (for refresh)
      scope?: string
    }

/** Get credentials for an MCP server. Returns null when no row exists. */
export const getMcpServerCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<McpServerCredentials | null> => {
  const row = await db.select().from(mcpSecretsTable).where(eq(mcpSecretsTable.id, id)).get()

  if (!row?.credentials) {
    return null
  }

  return JSON.parse(row.credentials) as McpServerCredentials
}

/**
 * Save credentials for an MCP server (insert or update).
 * Uses SELECT-then-INSERT-or-UPDATE because PowerSync local-only tables are views that don't support UPSERT.
 */
export const setMcpServerCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
  credentials: McpServerCredentials,
): Promise<void> => {
  const json = JSON.stringify(credentials)
  const existing = await db.select().from(mcpSecretsTable).where(eq(mcpSecretsTable.id, id)).get()

  if (existing) {
    await db.update(mcpSecretsTable).set({ credentials: json }).where(eq(mcpSecretsTable.id, id))
  } else {
    await db.insert(mcpSecretsTable).values({ id, credentials: json })
  }
}

/** Delete credentials for an MCP server. */
export const deleteMcpServerCredentials = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.delete(mcpSecretsTable).where(eq(mcpSecretsTable.id, id))
}
