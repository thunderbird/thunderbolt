/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, getTableColumns, isNotNull, isNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import {
  modelsTable,
  providerConnectionsTable as connections,
  providerConnectionSecretsTable as secrets,
} from '@/db/tables'
import type { DrizzleQueryWithPromise } from '@/types'
import type { ProviderAuthMethod, ProviderConnection, ProviderCredentials, ProviderType } from '@/providers/types'
import { credentialBinding, providerCredentialConnected, writeProviderCredentials } from '@/providers/credentials'
import { getProviderDefinition } from '@/providers/registry'
import {
  assertProviderConnectionAttemptCurrent,
  type ProviderConnectionAttempt,
} from '@/lib/provider-connection-attempt'
import { tinfoilSession, withTinfoilSessionLock } from '@/lib/tinfoil-session'
import { getOtariEndpoints, normalizeOtariOrigin } from '@/lib/otari-auth'
import { getProviderConnectionRevision } from '@/providers/revision'
export { getProviderConnectionRevision } from '@/providers/revision'

/** Reactive metadata query; credentials never enter connection list components. */
export const getProviderConnections = (db: AnyDrizzleDatabase) => {
  const query = db
    .select({ ...getTableColumns(connections), connected: providerCredentialConnected })
    .from(connections)
    .leftJoin(secrets, eq(secrets.id, connections.id))
    .where(isNull(connections.deletedAt))
    .orderBy(connections.name)
  return query as typeof query & DrizzleQueryWithPromise<ProviderConnection>
}

/** Connection references used by saved models, without reading device credentials. */
export const getModelProviderConnectionIds = (db: AnyDrizzleDatabase) =>
  db
    .select({ connectionId: modelsTable.providerConnectionId })
    .from(modelsTable)
    .where(and(isNull(modelsTable.deletedAt), isNotNull(modelsTable.providerConnectionId)))
    .groupBy(modelsTable.providerConnectionId)

/** Return active connection metadata, including whether this device is authenticated. */
export const getProviderConnection = async (db: AnyDrizzleDatabase, id: string): Promise<ProviderConnection | null> => {
  const rows = await getProviderConnections(db)
  return rows.find((row) => row.id === id) ?? null
}

/** Resolve only locally approved credentials for a currently enabled connection. */
export const getProviderCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<ProviderCredentials | null> => {
  const row = await db
    .select({ credentials: secrets.credentials })
    .from(connections)
    .innerJoin(secrets, eq(connections.id, secrets.id))
    .where(and(eq(connections.id, id), eq(connections.enabled, 1), providerCredentialConnected))
    .get()
  return row?.credentials ? (JSON.parse(row.credentials) as ProviderCredentials) : null
}

type SaveProviderConnection = {
  id?: string
  provider: ProviderType
  name: string
  url?: string | null
  authMethod: ProviderAuthMethod
  credentials: ProviderCredentials
  enabled?: boolean
  attempt?: ProviderConnectionAttempt
  signal?: AbortSignal
  expectedRevision?: string | null
}

/** Save metadata and device credentials atomically, independently of any model. */
export const saveProviderConnection = async (db: AnyDrizzleDatabase, input: SaveProviderConnection): Promise<string> =>
  (await saveProviderConnectionWithRevision(db, input)).id

/** Capture the saved generation before another window can replace or disconnect it. */
export const saveProviderConnectionWithRevision = (
  db: AnyDrizzleDatabase,
  input: SaveProviderConnection,
): Promise<{ id: string; revision: string }> => {
  const save = () =>
    db.transaction(async (tx) => {
      const id = await saveProviderConnectionInTransaction(tx, input)
      const revision = (await getProviderConnectionRevision(tx, id))!
      input.signal?.throwIfAborted()
      return { id, revision }
    })
  return input.provider === 'tinfoil' && input.authMethod === 'oauth' ? withTinfoilSessionLock(save) : save()
}

/** Caller-owned transaction variant used by idempotent legacy migrations. */
export const saveProviderConnectionInTransaction = async (
  db: AnyDrizzleDatabase,
  input: SaveProviderConnection,
): Promise<string> => {
  input.signal?.throwIfAborted()
  const definition = getProviderDefinition(input.provider)
  if (!input.name.trim()) {
    throw new Error('A connection name is required')
  }
  if (input.authMethod === 'oauth' && !definition.oauth) {
    throw new Error('Provider does not support OAuth')
  }
  const id = input.authMethod === 'oauth' ? `oauth:${input.provider}` : (input.id ?? crypto.randomUUID())
  if (input.authMethod === 'api_key' && id.startsWith('oauth:')) {
    throw new Error('OAuth connection identities are reserved for OAuth authorization')
  }
  if (
    input.expectedRevision !== undefined &&
    (await getProviderConnectionRevision(db, id)) !== input.expectedRevision
  ) {
    throw new Error('The provider connection changed during verification. Try again.')
  }
  if (input.id && input.id !== id) {
    throw new Error('Only one OAuth connection is supported per provider')
  }
  const url = normalizeProviderConnectionUrl(input.provider, input.url)
  if (input.provider !== 'custom' && !(input.credentials.apiKey || input.credentials.access_token)) {
    throw new Error('Provider credentials are required')
  }
  if (input.attempt) {
    if (input.attempt.provider !== input.provider) {
      throw new Error('Authorization provider does not match')
    }
    await assertProviderConnectionAttemptCurrent(db, input.attempt)
  }
  const existing = await db.select().from(connections).where(eq(connections.id, id)).get()
  if (existing && (existing.provider !== input.provider || existing.authMethod !== input.authMethod)) {
    throw new Error('A connection cannot change provider or authentication method')
  }
  const now = nextConnectionTimestamp(existing?.updatedAt)
  const values = {
    provider: input.provider,
    name: input.name.trim(),
    url,
    authMethod: input.authMethod,
    enabled: input.enabled === false ? 0 : 1,
    updatedAt: now,
    deletedAt: null,
  }
  if (existing) {
    await db.update(connections).set(values).where(eq(connections.id, id))
  } else {
    await db.insert(connections).values({ id, ...values, createdAt: now })
  }
  await writeProviderCredentials(
    db,
    id,
    { ...input.credentials, sessionRevision: crypto.randomUUID() },
    credentialBinding(values),
  )
  input.signal?.throwIfAborted()
  return id
}

/** Use one endpoint policy for saved connections and imported credential bindings. */
export const normalizeProviderConnectionUrl = (provider: ProviderType, value?: string | null): string | null => {
  const definition = getProviderDefinition(provider)
  const requestedUrl = definition.requiresUrl
    ? value?.trim().replace(/\/+$/, '') || definition.defaultUrl || null
    : null
  const url = provider === 'otari' && requestedUrl ? normalizeOtariConnectionUrl(requestedUrl) : requestedUrl
  if (definition.requiresUrl && !url) {
    throw new Error('A server URL is required')
  }
  if (url) {
    const parsed = new URL(url)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('Invalid provider URL')
    }
  }
  return url
}

/** Accept dashboard origins or the canonical inference endpoint for Otari. */
export const normalizeOtariConnectionUrl = (value: string): string => {
  const url = new URL(value)
  if (url.pathname !== '/' && url.pathname !== '/api/v1') {
    throw new Error('Enter an Otari server origin or API endpoint')
  }
  normalizeOtariOrigin(`${url.protocol}//${url.host}`)
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Otari URL')
  }
  return getOtariEndpoints(url.origin).inference
}

/** Catalog snapshots use updatedAt; rapid credential replacements must still advance it. */
const nextConnectionTimestamp = (previous: string | null | undefined): string =>
  new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString()

/** Rename or enable a connection without changing its models' individual preferences. */
export const updateProviderConnection = async (
  db: AnyDrizzleDatabase,
  id: string,
  updates: { name?: string; enabled?: boolean },
): Promise<void> => {
  if (updates.name !== undefined && !updates.name.trim()) {
    throw new Error('A connection name is required')
  }
  const update = () =>
    db.transaction(async (tx) => {
      const previous = await getProviderConnection(tx, id)
      await tx
        .update(connections)
        .set({
          ...(updates.name === undefined ? {} : { name: updates.name.trim() }),
          ...(updates.enabled === undefined ? {} : { enabled: updates.enabled ? 1 : 0 }),
          updatedAt: nextConnectionTimestamp(previous?.updatedAt),
        })
        .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
      if (previous?.authMethod === 'oauth') {
        // Local authorization does not determine the synced enabled preference.
        await tx
          .update(secrets)
          .set({
            credentials: sql`json_set(COALESCE(${secrets.credentials}, '{}'), '$.sessionRevision', ${crypto.randomUUID()})`,
          })
          .where(eq(secrets.id, id))
      }
    })
  return id === 'oauth:tinfoil' ? withTinfoilSessionLock(update) : update()
}

/** Disconnect only this device, retaining models and synced connection identity. */
export const disconnectProviderConnection = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  const row = await getProviderConnection(db, id)
  if (row?.provider === 'tinfoil' && row.authMethod === 'oauth') {
    await tinfoilSession.disconnect()
    return
  }
  await db.transaction(async (tx) => {
    await writeProviderCredentials(tx, id, { sessionRevision: crypto.randomUUID() }, null)
  })
}

/** Remove connection metadata through a tombstone; model/history references remain intact. */
export const deleteProviderConnection = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await disconnectProviderConnection(db, id)
  await db.update(connections).set({ deletedAt: new Date().toISOString(), enabled: 0 }).where(eq(connections.id, id))
}

/** Resolve live authentication at request time, including serialized Tinfoil refresh. */
export const resolveProviderConnection = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<{ connection: ProviderConnection; apiKey: string; revision?: string }> => {
  const row = await db
    .select({ ...getTableColumns(connections), credentials: secrets.credentials })
    .from(connections)
    .innerJoin(secrets, eq(secrets.id, connections.id))
    .where(and(eq(connections.id, id), eq(connections.enabled, 1), providerCredentialConnected))
    .get()
  if (!row?.credentials) {
    throw new Error('Connect this provider on this device before using it')
  }
  const { credentials: serialized, ...metadata } = row
  const connection = { ...metadata, connected: true } as ProviderConnection
  const credentials = JSON.parse(serialized) as ProviderCredentials
  const apiKey =
    connection.provider === 'tinfoil' && connection.authMethod === 'oauth'
      ? await tinfoilSession.getAccessToken()
      : (credentials.apiKey ?? credentials.access_token ?? '')
  if (connection.provider === 'tinfoil' && connection.authMethod === 'oauth') {
    const current = await getProviderCredentials(db, id)
    if (!current || current.sessionRevision !== credentials.sessionRevision) {
      throw new Error('The provider connection changed during token refresh')
    }
  }
  return { connection, apiKey, revision: credentials.sessionRevision }
}
