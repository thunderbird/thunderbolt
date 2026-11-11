/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deletePromptsForModel } from './model-prompt-deletion'

import { and, desc, eq, getTableColumns, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import {
  integrationsSecretsTable,
  modelsSecretsTable,
  modelsTable,
  settingsTable,
  providerConnectionsTable as connections,
  providerConnectionSecretsTable as secrets,
} from '../db/tables'
import { providerCredentialConnected } from '@/providers/credentials'
import { defaultModelId, hashModel, type SharedModel } from '@shared/defaults/models'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { DrizzleQueryWithPromise, Model } from '@/types'
import { getLastMessage } from './chat-messages'
import { createDefaultModelProfile, deleteModelProfileForModel } from './model-profiles'
import { usesLocalProviders } from '@/lib/provider-mode'
import { isModelReady } from '@/settings/models/model-policy'

/** Models whose requests and credentials do not require a Thunderbolt server. */
const standaloneModelCondition = sql`${modelsTable.provider} != 'thunderbolt' AND (${modelsTable.provider} != 'tinfoil' OR COALESCE(${modelsTable.isSystem}, 0) != 1)`

/** Hidden preview providers cannot remain active through a saved model selection. */
const providerVisibilityCondition = sql`(${modelsTable.provider} != 'otari' OR EXISTS (
  SELECT 1 FROM ${settingsTable} AS provider_settings
  WHERE provider_settings.id = 'experimental_feature_otari'
    AND provider_settings.value = 'true'
))`

/** A model can use only the enabled, locally approved connection for its own provider. */
const modelConnectionReady = sql`${connections.provider} = ${modelsTable.provider} AND ${connections.enabled} = 1 AND ${providerCredentialConnected}`

/** OAuth access is connection state, independent of the user's per-model toggle. */
const providerConnectionCondition = sql`CASE WHEN ${modelsTable.providerConnectionId} IS NOT NULL
  THEN ${modelConnectionReady}
  ELSE (${modelsSecretsTable.oauthProvider} IS NULL OR EXISTS (
  SELECT 1 FROM ${integrationsSecretsTable}
  WHERE ${integrationsSecretsTable.provider} = ${modelsSecretsTable.oauthProvider}
    AND ${integrationsSecretsTable.enabled} = 1
    AND CASE WHEN json_valid(${integrationsSecretsTable.credentials})
      THEN COALESCE(json_extract(${integrationsSecretsTable.credentials}, '$.access_token'), '') != ''
        AND COALESCE(json_extract(${integrationsSecretsTable.credentials}, '$.reauth_required'), 0) = 0
      ELSE 0 END
)) END`

/** Select columns: all model columns + apiKey from the local-only secrets table. */
const modelWithSecretColumns = {
  ...getTableColumns(modelsTable),
  url: sql<
    string | null
  >`CASE WHEN ${modelsTable.providerConnectionId} IS NOT NULL THEN ${connections.url} ELSE ${modelsTable.url} END`,
  connectionName: sql<string | null>`${connections.name}`.as('connection_name'),
  connectionReady:
    sql<boolean>`CASE WHEN ${modelsTable.providerConnectionId} IS NOT NULL THEN COALESCE(${modelConnectionReady}, 0) ELSE 1 END`.mapWith(
      Boolean,
    ),
  apiKey: sql<
    string | null
  >`CASE WHEN ${modelsTable.providerConnectionId} IS NOT NULL THEN CASE WHEN ${modelConnectionReady} THEN COALESCE(json_extract(${secrets.credentials}, '$.apiKey'), json_extract(${secrets.credentials}, '$.access_token')) END ELSE ${modelsSecretsTable.apiKey} END`,
  oauthProvider: sql<
    'tinfoil' | null
  >`CASE WHEN ${modelsTable.providerConnectionId} IS NOT NULL THEN CASE WHEN ${connections.provider} = 'tinfoil' AND ${connections.authMethod} = 'oauth' THEN 'tinfoil' END ELSE ${modelsSecretsTable.oauthProvider} END`,
  providerDefault: modelsSecretsTable.providerDefault,
  hasLocalCredentialRecord: sql<boolean>`${modelsSecretsTable.modelId} IS NOT NULL`.mapWith(Boolean),
}

/** Base query that LEFT JOINs models with their local-only secrets. */
const selectModelsWithSecrets = (db: AnyDrizzleDatabase) =>
  db
    .select(modelWithSecretColumns)
    .from(modelsTable)
    .leftJoin(modelsSecretsTable, eq(modelsTable.id, modelsSecretsTable.modelId))
    .leftJoin(connections, eq(modelsTable.providerConnectionId, connections.id))
    .leftJoin(secrets, eq(connections.id, secrets.id))

/**
 * Gets all models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAllModels = (db: AnyDrizzleDatabase) => {
  const query = selectModelsWithSecrets(db)
    .where(isNull(modelsTable.deletedAt))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

/**
 * Gets all available (enabled) models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAvailableModels = (db: AnyDrizzleDatabase) => {
  const query = selectModelsWithSecrets(db)
    .where(
      and(
        eq(modelsTable.enabled, 1),
        providerConnectionCondition,
        providerVisibilityCondition,
        isNull(modelsTable.deletedAt),
        usesLocalProviders() ? standaloneModelCondition : undefined,
      ),
    )
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

export const getModelQuery = (db: AnyDrizzleDatabase, id: string) => {
  const query = selectModelsWithSecrets(db).where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

/** Read the live reasoning preference without resolving provider credentials or model availability. */
export const getModelReasoningEffortQuery = (db: AnyDrizzleDatabase, id: string) =>
  db
    .select({ reasoningEffort: modelsTable.reasoningEffort })
    .from(modelsTable)
    .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))

/**
 * Returns a Drizzle query for the currently selected model, falling back to system model.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 * Returns the selected model if it exists and is enabled; otherwise the system model.
 */
export const getSelectedModelQuery = (db: AnyDrizzleDatabase) => {
  const standalone = usesLocalProviders()
  const query = selectModelsWithSecrets(db)
    .leftJoin(
      settingsTable,
      and(eq(settingsTable.key, 'selected_model'), eq(settingsTable.value, modelsTable.id), eq(modelsTable.enabled, 1)),
    )
    .where(
      and(
        isNull(modelsTable.deletedAt),
        providerConnectionCondition,
        providerVisibilityCondition,
        or(
          eq(modelsTable.isSystem, 1),
          isNotNull(settingsTable.value),
          standalone ? eq(modelsTable.enabled, 1) : undefined,
        ),
      ),
    )
    .orderBy(
      ...(standalone
        ? [sql`CASE WHEN ${standaloneModelCondition} AND ${modelsTable.enabled} = 1 THEN 0 ELSE 1 END`]
        : []),
      sql`CASE WHEN ${settingsTable.value} IS NOT NULL THEN 0 ELSE 1 END`,
      desc(eq(modelsTable.id, defaultModelId)),
      modelsTable.name,
    )
    .limit(1)

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

/**
 * Gets a specific model by ID (excluding soft-deleted)
 */
export const getModel = async (db: AnyDrizzleDatabase, id: string): Promise<Model | null> => {
  const model = await getModelQuery(db, id).get()
  return model ? (model as Model) : null
}

export const getSystemModel = async (db: AnyDrizzleDatabase): Promise<Model | null> => {
  const systemModel = await selectModelsWithSecrets(db)
    .where(and(eq(modelsTable.isSystem, 1), isNull(modelsTable.deletedAt)))
    .orderBy(modelsTable.name)
    .get()
  return systemModel ? (systemModel as Model) : null
}

/**
 * Gets the currently selected model or falls back to the system default model
 * If the selected model is disabled, automatically falls back to system model
 */
export const getSelectedModel = async (db: AnyDrizzleDatabase): Promise<Model> => {
  const result = await getSelectedModelQuery(db).all()
  const row = result[0]
  if (!row) {
    throw new Error('No system model found')
  }
  return row as Model
}

/**
 * Uses the last message's enabled model, falling back to the selected or system default model.
 */
export const getDefaultModelForThread = async (db: AnyDrizzleDatabase, threadId: string): Promise<Model> => {
  const lastMessage = await getLastMessage(db, threadId)

  if (lastMessage?.modelId) {
    const models = (await getAvailableModels(db)) as Model[]
    const model = models.find((candidate) => candidate.id === lastMessage.modelId)

    if (model && isModelReady(model)) {
      return model
    }
  }

  return await getSelectedModel(db)
}

type ModelTransaction = Parameters<Parameters<AnyDrizzleDatabase['transaction']>[0]>[0]

/** Update a model and its local credentials atomically. */
export const updateModel = (db: AnyDrizzleDatabase, id: string, updates: Partial<Model>): Promise<void> =>
  db.transaction((tx) => updateModelInTransaction(tx, id, updates))

/** Update within the caller's transaction; PowerSync does not support nested transactions. */
export const updateModelInTransaction = async (
  tx: ModelTransaction,
  id: string,
  updates: Partial<Model>,
): Promise<void> => {
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const {
    defaultHash,
    hasLocalCredentialRecord,
    connectionName,
    connectionReady,
    apiKey,
    oauthProvider,
    providerDefault,
    ...updateFields
  } = updates as Partial<Model> & {
    defaultHash?: string
  }

  if (Object.keys(updateFields).length > 0) {
    await tx.update(modelsTable).set(updateFields).where(eq(modelsTable.id, id))
  }

  // PowerSync exposes local-only tables as SQLite views, which don't support
  // INSERT...ON CONFLICT DO UPDATE. Emulate UPSERT with SELECT-then-INSERT/UPDATE.
  if (apiKey !== undefined || oauthProvider !== undefined || providerDefault !== undefined) {
    const existing = await tx.select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, id)).get()
    const credentials = {
      providerDefault: providerDefault === undefined ? (existing?.providerDefault ?? null) : providerDefault,
      apiKey: apiKey === undefined ? (existing?.apiKey ?? null) : apiKey,
      // Explicit key changes switch back to BYOK; clearing access clears either kind.
      oauthProvider:
        oauthProvider === undefined ? (apiKey === undefined ? (existing?.oauthProvider ?? null) : null) : oauthProvider,
    }
    if (existing) {
      await tx.update(modelsSecretsTable).set(credentials).where(eq(modelsSecretsTable.modelId, id))
    } else if (credentials.apiKey !== null || credentials.oauthProvider !== null || credentials.providerDefault === 1) {
      await tx.insert(modelsSecretsTable).values({ modelId: id, ...credentials })
    }
  }
}

/**
 * Reset a model to its default state. Recomputes `defaultHash` so that any
 * legacy/stale value left over from a previous `hashModel` formula is replaced
 * with the current one — otherwise `isModelModified` would keep flagging the
 * row as modified even right after a reset. `userId` is stripped from the
 * default template so we never overwrite the row's real owner with `null`
 * (which would surface as an empty PATCH and a 400 from the upload handler).
 */
export const resetModelToDefault = async (
  db: AnyDrizzleDatabase,
  id: string,
  defaultModel: SharedModel,
): Promise<void> => {
  const { defaultHash, userId, ...defaultFields } = defaultModel
  await db.transaction(async (tx) => {
    await tx
      .update(modelsTable)
      .set({ ...defaultFields, defaultHash: hashModel(defaultModel) })
      .where(eq(modelsTable.id, id))
    await tx.delete(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, id))
  })
}

/**
 * Soft deletes a model by ID (sets deletedAt datetime)
 * Also soft-deletes all prompts referencing this model (and their triggers)
 * Scrubs all non-enum data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteModel = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await deleteModelProfileForModel(tx, id)
    await deletePromptsForModel(tx, id)
    await tx.delete(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, id))
    await tx
      .update(modelsTable)
      .set({ ...clearNullableColumns(modelsTable), deletedAt: nowIso() })
      .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))
  })
}

type NewModel = Partial<Model> & Pick<Model, 'id' | 'provider' | 'name' | 'model'>

/** Create a model and its local credentials atomically. */
export const createModel = (db: AnyDrizzleDatabase, data: NewModel): Promise<void> =>
  db.transaction((tx) => createModelInTransaction(tx, data))

/** Create within the caller's transaction so provider sessions and models commit together. */
export const createModelInTransaction = async (tx: ModelTransaction, data: NewModel): Promise<void> => {
  const {
    hasLocalCredentialRecord,
    connectionName,
    connectionReady,
    apiKey,
    oauthProvider,
    providerDefault,
    ...modelData
  } = data
  await tx.insert(modelsTable).values(modelData)
  if (apiKey != null || oauthProvider || providerDefault === 1) {
    await tx.insert(modelsSecretsTable).values({ modelId: data.id, apiKey, oauthProvider, providerDefault })
  }
  await createDefaultModelProfile(tx, data.id)
}
