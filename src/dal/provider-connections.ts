/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import {
  modelsTable,
  providerConnectionsTable as connections,
  providerConnectionSecretsTable as secrets,
} from '@/db/tables'
import type { DrizzleQueryWithPromise } from '@/types'
import type {
  ProviderAuthMethod,
  ProviderConnection,
  ProviderCredentials,
  ProviderType,
  OAuthProviderType,
} from '@/providers/types'
import {
  credentialBinding,
  providerCredentialConnected,
  providerCredentialNeedsConsent,
  writeProviderCredentials,
} from '@/providers/credentials'
import { getProviderDefinition } from '@/providers/registry'
import { providerTypes } from '@/providers/types'
import {
  assertProviderConnectionAttemptCurrent,
  type ProviderConnectionAttempt,
} from '@/lib/provider-connection-attempt'
import { revokeChatGPTSession } from '@/providers/chatgpt-session'
import { writeChatGPTRegistration } from '@/providers/chatgpt-registration'
import { resolveOAuthAccessToken, withProviderOAuthLock } from '@/providers/oauth-session'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import { providerConnectionMigrationMetadata } from '@/db/powersync/crud-metadata'
import { revokeReplacedTinfoilAuthorization, tinfoilSession, withTinfoilSessionLock } from '@/lib/tinfoil-session'
import { getOtariEndpoints, normalizeOtariOrigin } from '@/lib/otari-auth'
import { isCurrentOtariAuthorization, revokeStoredOtariAuthorization } from '@/providers/otari-session'
import { getProviderConnectionRevision } from '@/providers/revision'
export { getProviderConnectionRevision } from '@/providers/revision'

// Sync can deliver partial rows or providers introduced by newer clients. Keep them stored
// until their metadata is usable by this client, including reactive query subscribers.
const supportedConnectionMetadata = and(
  inArray(connections.provider, providerTypes),
  inArray(connections.authMethod, ['oauth', 'api_key']),
  sql`trim(${connections.name}) != ''`,
)

/** Share the metadata projection without exposing credentials to callers. */
const selectProviderConnections = (db: AnyDrizzleDatabase) =>
  db
    .select({
      ...getTableColumns(connections),
      connected: providerCredentialConnected,
      needsConsent: providerCredentialNeedsConsent,
    })
    .from(connections)
    .leftJoin(secrets, eq(secrets.id, connections.id))

/** Reactive metadata query; credentials never enter connection list components. */
export const getProviderConnections = (db: AnyDrizzleDatabase) => {
  const query = selectProviderConnections(db)
    .where(and(isNull(connections.deletedAt), supportedConnectionMetadata))
    .orderBy(connections.name)
  return query as DrizzleQueryWithPromise<ProviderConnection>
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
  const row = await selectProviderConnections(db)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt), supportedConnectionMetadata))
    .get()
  return (row as ProviderConnection | undefined) ?? null
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
    .where(
      and(eq(connections.id, id), eq(connections.enabled, 1), supportedConnectionMetadata, providerCredentialConnected),
    )
    .get()
  return row?.credentials ? (JSON.parse(row.credentials) as ProviderCredentials) : null
}

export type SaveProviderConnection = {
  id?: string
  provider: ProviderType
  name: string
  url?: string | null
  authMethod: ProviderAuthMethod
  credentials: ProviderCredentials
  enabled?: boolean
  attempt?: ProviderConnectionAttempt<OAuthProviderType>
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
  const save = (next = input) =>
    db.transaction(async (tx) => {
      const id = await saveProviderConnectionInTransaction(tx, next)
      const revision = (await getProviderConnectionRevision(tx, id))!
      next.signal?.throwIfAborted()
      return { id, revision }
    })
  if (input.authMethod !== 'oauth') {
    return save()
  }
  if (input.provider === 'tinfoil') {
    return withTinfoilSessionLock(async () => {
      const guarded = {
        ...input,
        expectedRevision:
          input.expectedRevision === undefined
            ? await getProviderConnectionRevision(db, 'oauth:tinfoil')
            : input.expectedRevision,
      }
      await prepareProviderConnectionSave(db, guarded)
      await revokeReplacedTinfoilAuthorization(
        db,
        { ...input.credentials, access_token: input.credentials.access_token ?? input.credentials.apiKey! },
        input.signal,
      )
      return save(guarded)
    })
  }
  if (input.provider === 'otari') {
    return withProviderOAuthLock('oauth:otari', async () => {
      const guarded = {
        ...input,
        expectedRevision:
          input.expectedRevision === undefined
            ? await getProviderConnectionRevision(db, 'oauth:otari')
            : input.expectedRevision,
      }
      const { url } = await prepareProviderConnectionSave(db, guarded)
      if (!(await isCurrentOtariAuthorization(db, url, input.credentials.access_token ?? input.credentials.apiKey!))) {
        await revokeStoredOtariAuthorization(db)
      }
      return save(guarded)
    })
  }
  if (input.provider !== 'openai') {
    return save()
  }
  return withProviderOAuthLock('oauth:openai', async () => {
    const guarded = {
      ...input,
      expectedRevision:
        input.expectedRevision === undefined
          ? await getProviderConnectionRevision(db, 'oauth:openai')
          : input.expectedRevision,
    }
    const { id } = await prepareProviderConnectionSave(db, guarded)
    const stored = await db.select().from(secrets).where(eq(secrets.id, id)).get()
    const previous = JSON.parse(stored?.credentials ?? '{}') as ProviderCredentials
    if (previous.refresh_token && previous.oauth && previous.oauth.clientId !== input.credentials.oauth?.clientId) {
      input.signal?.throwIfAborted()
      await revokeChatGPTSession(previous)
      // Revocation cannot be undone by cancelling the switch. Retire only that old session,
      // preserving concurrent metadata edits and the generation used by the guarded replacement.
      await db
        .update(secrets)
        .set({ credentials: sql`json_set(${secrets.credentials}, '$.reauth_required', json('true'))` })
        .where(
          and(
            eq(secrets.id, id),
            sql`json_extract(${secrets.credentials}, '$.refresh_token') = ${previous.refresh_token}`,
            sql`json_extract(${secrets.credentials}, '$.oauth.clientId') = ${previous.oauth.clientId}`,
          ),
        )
    }
    return save(guarded)
  })
}

/** Validate a save before external revocation and again inside the final write transaction. */
export const prepareProviderConnectionSave = async (db: AnyDrizzleDatabase, input: SaveProviderConnection) => {
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
  return { id, url, existing }
}

/** Caller-owned transaction variant used by idempotent legacy migrations. */
export const saveProviderConnectionInTransaction = async (
  db: AnyDrizzleDatabase,
  input: SaveProviderConnection,
  { createOnly = false }: { createOnly?: boolean } = {},
): Promise<string> => {
  const { id, url, existing } = await prepareProviderConnectionSave(db, input)
  if (input.provider === 'openai' && input.authMethod === 'oauth') {
    const stored = await db.select().from(secrets).where(eq(secrets.id, id)).get()
    const previous = JSON.parse(stored?.credentials ?? '{}') as ProviderCredentials
    if (previous.oauth) {
      await writeChatGPTRegistration(db, previous.oauth)
    }
    if (input.credentials.oauth) {
      await writeChatGPTRegistration(db, input.credentials.oauth)
    }
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
  } else if (createOnly) {
    const row = { id, ...values, createdAt: now }
    const columns = getTableColumns(connections)
    const keys = Object.keys(row) as (keyof typeof row)[]
    // _metadata is a PowerSync write-only column, deliberately absent from the Drizzle row schema.
    await db.run(sql`INSERT INTO ${connections} (
      ${sql.join(
        keys.map((key) => sql.identifier(columns[key].name)),
        sql`, `,
      )}, _metadata
    ) VALUES (
      ${sql.join(
        keys.map((key) => sql`${row[key]}`),
        sql`, `,
      )}, ${providerConnectionMigrationMetadata}
    )`)
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
      if (previous && updates.enabled !== undefined && previous.enabled !== Number(updates.enabled)) {
        // Re-enabling grants new turns access; a previously bound turn stays retired.
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
  if (row?.provider === 'otari' && row.authMethod === 'oauth') {
    await withProviderOAuthLock(id, () => revokeStoredOtariAuthorization(db, { disconnect: true }))
    return
  }
  if (id === 'oauth:tinfoil') {
    await tinfoilSession.disconnect()
    return
  }
  if (row?.provider === 'openai' && row.authMethod === 'oauth') {
    await withProviderOAuthLock(id, async () => {
      const stored = await db.select().from(secrets).where(eq(secrets.id, id)).get()
      const credentials = JSON.parse(stored?.credentials ?? '{}') as ProviderCredentials
      await revokeChatGPTSession(credentials)
      const registration = credentials.oauth ? { ...credentials.oauth, idToken: undefined } : undefined
      await db.transaction(async (tx) => {
        const current = await tx.select().from(secrets).where(eq(secrets.id, id)).get()
        const active = JSON.parse(current?.credentials ?? '{}') as ProviderCredentials
        const sameSession =
          active.oauth?.clientId === credentials.oauth?.clientId &&
          (credentials.refresh_token
            ? active.refresh_token === credentials.refresh_token
            : active.access_token === credentials.access_token && !active.refresh_token)
        if (!sameSession) {
          throw new Error('ChatGPT session changed during disconnect')
        }
        if (registration) {
          await writeChatGPTRegistration(tx, registration)
        }
        await writeProviderCredentials(tx, id, { sessionRevision: crypto.randomUUID(), oauth: registration }, null)
      })
    })
    return
  }
  await db.transaction(async (tx) => {
    await writeProviderCredentials(tx, id, { sessionRevision: crypto.randomUUID() }, null)
  })
}

/** Remove connection metadata through a tombstone; model/history references remain intact. */
export const deleteProviderConnection = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  if (id === 'oauth:otari') {
    await withProviderOAuthLock(id, async () => {
      await revokeStoredOtariAuthorization(db, { disconnect: true })
      await db
        .update(connections)
        .set({ deletedAt: new Date().toISOString(), enabled: 0 })
        .where(eq(connections.id, id))
    })
    return
  }
  await disconnectProviderConnection(db, id)
  await db.transaction(async (tx) => {
    const current = await tx.select({ binding: secrets.binding }).from(secrets).where(eq(secrets.id, id)).get()
    // Disconnect clears the binding. A replacement authorization must not be removed by this old request.
    if (current?.binding) {
      throw new Error('The provider connection changed during removal. Try again.')
    }
    await tx.update(connections).set({ deletedAt: new Date().toISOString(), enabled: 0 }).where(eq(connections.id, id))
  })
}

/** Resolve live authentication at request time, including serialized Tinfoil refresh. */
export const resolveProviderConnection = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<{ connection: ProviderConnection; apiKey: string; revision?: string }> => {
  const signal = getIdentitySignal()
  const row = await db
    .select({ ...getTableColumns(connections), credentials: secrets.credentials })
    .from(connections)
    .innerJoin(secrets, eq(secrets.id, connections.id))
    .where(
      and(eq(connections.id, id), eq(connections.enabled, 1), supportedConnectionMetadata, providerCredentialConnected),
    )
    .get()
  signal.throwIfAborted()
  if (!row?.credentials) {
    throw new Error('Connect this provider on this device before using it')
  }
  const { credentials: serialized, ...metadata } = row
  const connection = { ...metadata, connected: true } as ProviderConnection
  const credentials = JSON.parse(serialized) as ProviderCredentials
  const usesRefreshSession = connection.authMethod === 'oauth' && Boolean(credentials.oauth)
  const apiKey = usesRefreshSession
    ? await resolveOAuthAccessToken(db, id)
    : connection.provider === 'tinfoil' && connection.authMethod === 'oauth'
      ? await tinfoilSession.getAccessToken()
      : (credentials.apiKey ?? credentials.access_token ?? '')
  if (usesRefreshSession || (connection.provider === 'tinfoil' && connection.authMethod === 'oauth')) {
    const current = await getProviderCredentials(db, id)
    if (!current || current.sessionRevision !== credentials.sessionRevision) {
      throw new Error('The provider connection changed during token refresh')
    }
  }
  signal.throwIfAborted()
  return { connection, apiKey, revision: credentials.sessionRevision }
}
