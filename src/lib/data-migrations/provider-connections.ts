/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, getTableColumns, isNotNull, isNull, ne, or } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import {
  integrationsSecretsTable,
  modelsSecretsTable,
  modelsTable,
  providerConnectionsTable,
  providerConnectionSecretsTable,
} from '@/db/tables'
import { normalizeProviderConnectionUrl, saveProviderConnectionInTransaction } from '@/dal/provider-connections'
import { getProviderDefinition } from '@/providers/registry'
import { credentialBinding, writeProviderCredentials } from '@/providers/credentials'
import type { ProviderAuthMethod, ProviderCredentials, ProviderType } from '@/providers/types'

type LegacyConnection = {
  id: string
  provider: ProviderType
  name: string
  url: string | null
  authMethod: ProviderAuthMethod
  credentials: ProviderCredentials
  enabled?: boolean
}

/** Preserve legacy URLs the stricter connection policy cannot represent, without changing their credentials. */
const normalizeLegacyConnectionUrl = (provider: ProviderType, value: string | null): string | null | undefined => {
  try {
    return normalizeProviderConnectionUrl(provider, value)
  } catch {
    return undefined
  }
}

/** A synced reference may arrive before this device has moved its own credential. */
export const migrateLegacyProviderCredential = async (
  db: AnyDrizzleDatabase,
  input: LegacyConnection,
): Promise<boolean> => {
  if (input.authMethod === 'api_key' && input.id.startsWith('oauth:')) {
    // Another device may have used OAuth for the same model; wait for its metadata.
    return false
  }
  const existing = await db
    .select()
    .from(providerConnectionsTable)
    .where(eq(providerConnectionsTable.id, input.id))
    .get()
  if (!existing) {
    await saveProviderConnectionInTransaction(db, input)
    return true
  }
  const local = await db
    .select()
    .from(providerConnectionSecretsTable)
    .where(eq(providerConnectionSecretsTable.id, input.id))
    .get()
  // An explicit local edit/disconnect or global removal supersedes the old model credential.
  if (local || existing.deletedAt) {
    return true
  }
  if (existing.provider !== input.provider || existing.authMethod !== input.authMethod || existing.url !== input.url) {
    // Keep the old key and approved URL for recovery; never bind it to changed synced metadata.
    return false
  }
  await writeProviderCredentials(
    db,
    input.id,
    { ...input.credentials, sessionRevision: crypto.randomUUID() },
    credentialBinding(input),
  )
  return true
}

/** Move each legacy model's local key once, preserving its identity across independently upgraded devices. */
export const migrateProviderConnections = async (db: AnyDrizzleDatabase): Promise<void> =>
  db.transaction(async (tx) => {
    const tinfoil = await tx
      .select()
      .from(integrationsSecretsTable)
      .where(eq(integrationsSecretsTable.provider, 'tinfoil'))
      .get()
    const tokens = (() => {
      if (!tinfoil?.credentials) {
        return null
      }
      try {
        return JSON.parse(tinfoil.credentials) as ProviderCredentials
      } catch {
        throw new Error('The legacy Tinfoil credentials could not be read')
      }
    })()
    if (
      tokens?.access_token &&
      (await migrateLegacyProviderCredential(tx, {
        id: 'oauth:tinfoil',
        provider: 'tinfoil',
        name: 'Tinfoil',
        url: null,
        authMethod: 'oauth',
        credentials: tokens,
        enabled: tinfoil?.enabled === 1,
      }))
    ) {
      await tx
        .update(integrationsSecretsTable)
        .set({ credentials: null, enabled: 0 })
        .where(eq(integrationsSecretsTable.provider, 'tinfoil'))
    }
    // Keyless custom models retain their legacy URL for other devices. Retry only
    // while local credentials are missing or a legacy marker still needs cleanup.
    const rows = await tx
      .select(getTableColumns(modelsTable))
      .from(modelsTable)
      .leftJoin(modelsSecretsTable, eq(modelsSecretsTable.modelId, modelsTable.id))
      .leftJoin(providerConnectionsTable, eq(providerConnectionsTable.id, modelsTable.providerConnectionId))
      .leftJoin(providerConnectionSecretsTable, eq(providerConnectionSecretsTable.id, providerConnectionsTable.id))
      .where(
        and(
          isNull(modelsTable.deletedAt),
          or(
            ne(modelsSecretsTable.apiKey, ''),
            eq(modelsSecretsTable.oauthProvider, 'tinfoil'),
            and(
              eq(modelsTable.provider, 'custom'),
              ne(modelsTable.url, ''),
              or(isNull(providerConnectionSecretsTable.id), isNotNull(modelsSecretsTable.providerDefault)),
            ),
          ),
        ),
      )
      .orderBy(modelsTable.id)
    if (rows.length === 0) {
      return
    }
    const legacySecrets = new Map((await tx.select().from(modelsSecretsTable)).map((row) => [row.modelId, row]))
    for (const model of rows) {
      const secret = legacySecrets.get(model.id)
      if (
        !model.provider ||
        model.provider === 'thunderbolt' ||
        (model.provider === 'tinfoil' && model.isSystem === 1)
      ) {
        continue
      }
      const oauth = secret?.oauthProvider === 'tinfoil'
      const hasLegacyKey = Boolean(secret?.apiKey || oauth)
      const connectionId = model.providerConnectionId ?? (oauth ? 'oauth:tinfoil' : `legacy-model:${model.id}`)
      if (oauth && connectionId !== 'oauth:tinfoil') {
        // A synced API-key reference must not consume this device's OAuth marker.
        continue
      }
      if (!oauth) {
        const definition = getProviderDefinition(model.provider)
        const url = normalizeLegacyConnectionUrl(model.provider, model.url)
        if (url === undefined) {
          console.warn(
            '[provider-connections] Skipped legacy model: URL is unsupported by the current connection policy',
            {
              modelId: model.id,
              provider: model.provider,
            },
          )
          continue
        }
        const moved = await migrateLegacyProviderCredential(tx, {
          id: connectionId,
          provider: model.provider,
          name: `${definition.name} — ${model.name}`,
          url,
          authMethod: 'api_key',
          credentials: { apiKey: secret?.apiKey ?? '' },
        })
        if (!moved) {
          continue
        }
      }
      // Retain the approved legacy URL until every device has migrated its own local key.
      if (model.providerConnectionId !== connectionId) {
        await tx.update(modelsTable).set({ providerConnectionId: connectionId }).where(eq(modelsTable.id, model.id))
      }
      if (secret && (hasLegacyKey || secret.providerDefault !== null)) {
        await tx
          .update(modelsSecretsTable)
          .set({ apiKey: null, oauthProvider: null, providerDefault: null })
          .where(eq(modelsSecretsTable.modelId, model.id))
      }
    }
  })
