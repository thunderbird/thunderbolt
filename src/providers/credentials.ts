/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, exists, isNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { providerConnectionsTable as connections, providerConnectionSecretsTable as secrets } from '@/db/tables'
import type { ProviderCredentials } from './types'

type OAuthCredentialProvider = 'openrouter' | 'tinfoil' | 'otari'

/** Match credentials to the exact metadata approved on this device. */
export const credentialBinding = (connection: { provider: string; authMethod: string; url: string | null }): string =>
  JSON.stringify([connection.provider, connection.authMethod, connection.url])

export const providerCredentialBound = sql`${secrets.binding} = json_array(${connections.provider}, ${connections.authMethod}, ${connections.url})`
export const providerCredentialConnected =
  sql<boolean>`COALESCE((${connections.deletedAt} IS NULL AND ${providerCredentialBound}
  AND CASE WHEN json_valid(${secrets.credentials}) THEN
    COALESCE(json_extract(${secrets.credentials}, '$.reauth_required'), 0) = 0
    AND (${connections.provider} = 'custom' OR COALESCE(json_extract(${secrets.credentials}, '$.apiKey'), json_extract(${secrets.credentials}, '$.access_token'), '') != '')
    AND (${connections.provider} != 'tinfoil' OR ${connections.authMethod} != 'oauth'
      OR COALESCE(json_extract(${secrets.credentials}, '$.refresh_token'), '') != ''
      OR COALESCE(json_extract(${secrets.credentials}, '$.expires_at'), 0) > (unixepoch('now') * 1000 + 60000))
  ELSE 0 END), 0)`.mapWith(Boolean)

/** Persist a local credential without relying on UPSERT, unsupported by PowerSync views. */
export const writeProviderCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
  credentials: ProviderCredentials | null,
  binding: string | null,
): Promise<void> => {
  const values = { credentials: credentials ? JSON.stringify(credentials) : null, binding }
  const existing = await db.select({ id: secrets.id }).from(secrets).where(eq(secrets.id, id)).get()
  if (existing) {
    await db.update(secrets).set(values).where(eq(secrets.id, id))
  } else {
    await db.insert(secrets).values({ id, ...values })
  }
}

/** Read the OAuth generation even after disconnect; stale callbacks must remain invalid. */
export const readOAuthCredentials = async (db: AnyDrizzleDatabase, provider: OAuthCredentialProvider) => {
  const id = `oauth:${provider}`
  const row = await db
    .select({
      provider: connections.provider,
      authMethod: connections.authMethod,
      url: connections.url,
      deletedAt: connections.deletedAt,
      enabled: connections.enabled,
      credentials: secrets.credentials,
      binding: secrets.binding,
    })
    .from(connections)
    .leftJoin(secrets, eq(secrets.id, connections.id))
    .where(eq(connections.id, id))
    .get()
  if (!row) {
    return null
  }
  const credentials = row.credentials ? (JSON.parse(row.credentials) as ProviderCredentials) : {}
  const bound =
    row.provider === provider &&
    row.authMethod === 'oauth' &&
    row.binding === credentialBinding({ provider: row.provider, authMethod: row.authMethod, url: row.url })
  return {
    credentials:
      bound && !row.deletedAt
        ? { ...credentials, access_token: credentials.access_token ?? credentials.apiKey ?? '' }
        : { access_token: '', sessionRevision: credentials.sessionRevision },
    enabled: row.enabled === 1 && !row.deletedAt && bound,
  }
}

/** Update an existing OAuth session; its routing identity is never changed by token refresh. */
export const writeOAuthCredentials = async (
  db: AnyDrizzleDatabase,
  provider: OAuthCredentialProvider,
  credentials: ProviderCredentials,
  enabled: boolean,
  preserveEnabled = false,
): Promise<boolean> => {
  const id = `oauth:${provider}`
  const row = await db.select().from(connections).where(eq(connections.id, id)).get()
  if (!row) {
    return false
  }
  const secret = await db.select().from(secrets).where(eq(secrets.id, id)).get()
  if (preserveEnabled) {
    const activeConnection = db
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.id, id),
          eq(connections.provider, provider),
          eq(connections.authMethod, 'oauth'),
          eq(connections.enabled, 1),
          isNull(connections.deletedAt),
          providerCredentialBound,
        ),
      )
    // The caller checks its pre-request snapshot in a transaction. This CAS also
    // protects the bridge from a write between its own read and update.
    const updated = await db
      .update(secrets)
      .set({ credentials: JSON.stringify(credentials) })
      .where(
        and(
          eq(secrets.id, id),
          sql`${secrets.credentials} IS ${secret?.credentials ?? null}`,
          sql`${secrets.binding} IS ${secret?.binding ?? null}`,
          sql`json_extract(${secrets.credentials}, '$.sessionRevision') IS ${credentials.sessionRevision ?? null}`,
          exists(activeConnection),
        ),
      )
      .returning({ id: secrets.id })
    if (updated.length === 0) {
      throw new Error('Provider connection changed during token refresh')
    }
    return true
  }
  await writeProviderCredentials(db, id, credentials, secret?.binding ?? null)
  await db
    .update(connections)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(connections.id, id))
  return true
}
