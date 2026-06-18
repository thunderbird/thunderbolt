/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, desc, eq, getTableColumns, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { modelsSecretsTable, modelsTable, settingsTable } from '../db/tables'
import { hashModel } from '../defaults/models'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { DrizzleQueryWithPromise, Model } from '@/types'
import { getLastMessage } from './chat-messages'
import { createDefaultModelProfile, deleteModelProfileForModel } from './model-profiles'

/** Select columns: all model columns + apiKey from the local-only secrets table. */
const modelWithSecretColumns = {
  ...getTableColumns(modelsTable),
  apiKey: modelsSecretsTable.apiKey,
}

/** Base query that LEFT JOINs models with their local-only secrets. */
const selectModelsWithSecrets = (db: AnyDrizzleDatabase) =>
  db
    .select(modelWithSecretColumns)
    .from(modelsTable)
    .leftJoin(modelsSecretsTable, eq(modelsTable.id, modelsSecretsTable.modelId))

/**
 * Gets all models in the given workspace (excluding soft-deleted), sorted with
 * system models first, then alphabetically by name.
 */
export const getAllModels = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = selectModelsWithSecrets(db)
    .where(and(eq(modelsTable.workspaceId, workspaceId), isNull(modelsTable.deletedAt)))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

/**
 * Gets all available (enabled) models in the given workspace (excluding soft-deleted),
 * sorted with system models first, then alphabetically by name.
 */
export const getAvailableModels = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = selectModelsWithSecrets(db)
    .where(and(eq(modelsTable.workspaceId, workspaceId), eq(modelsTable.enabled, 1), isNull(modelsTable.deletedAt)))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

export const getModelQuery = (db: AnyDrizzleDatabase, workspaceId: string, id: string) => {
  const query = selectModelsWithSecrets(db).where(
    and(eq(modelsTable.id, id), eq(modelsTable.workspaceId, workspaceId), isNull(modelsTable.deletedAt)),
  )

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

/**
 * Returns a Drizzle query for the currently selected model in the given workspace,
 * falling back to the workspace's system model. Use with PowerSync's toCompilableQuery,
 * or await the result to execute. Returns the selected model if it exists and is
 * enabled; otherwise the system model.
 */
export const getSelectedModelQuery = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = selectModelsWithSecrets(db)
    .leftJoin(
      settingsTable,
      and(eq(settingsTable.key, 'selected_model'), eq(settingsTable.value, modelsTable.id), eq(modelsTable.enabled, 1)),
    )
    .where(
      and(
        eq(modelsTable.workspaceId, workspaceId),
        isNull(modelsTable.deletedAt),
        or(eq(modelsTable.isSystem, 1), isNotNull(settingsTable.value)),
      ),
    )
    .orderBy(sql`CASE WHEN ${settingsTable.value} IS NOT NULL THEN 0 ELSE 1 END`, modelsTable.name)
    .limit(1)

  return query as typeof query & DrizzleQueryWithPromise<Model>
}

/**
 * Gets a specific model by ID in the given workspace (excluding soft-deleted)
 */
export const getModel = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<Model | null> => {
  const model = await getModelQuery(db, workspaceId, id).get()
  return model ? (model as Model) : null
}

export const getSystemModel = async (db: AnyDrizzleDatabase, workspaceId: string): Promise<Model | null> => {
  const systemModel = await selectModelsWithSecrets(db)
    .where(and(eq(modelsTable.workspaceId, workspaceId), eq(modelsTable.isSystem, 1), isNull(modelsTable.deletedAt)))
    .orderBy(modelsTable.name)
    .get()
  return systemModel ? (systemModel as Model) : null
}

/**
 * Gets the currently selected model in the given workspace or falls back to the
 * workspace's system default model. If the selected model is disabled, falls back.
 */
export const getSelectedModel = async (db: AnyDrizzleDatabase, workspaceId: string): Promise<Model> => {
  const result = await getSelectedModelQuery(db, workspaceId).all()
  const row = result[0]
  if (!row) {
    throw new Error('No system model found')
  }
  return row as Model
}

/**
 * Gets the default model for a chat thread based on the last message in the thread,
 * falling back to the selected_model setting then the workspace's system model.
 * If any fallback model is disabled, continues to the next fallback option.
 */
export const getDefaultModelForThread = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  threadId: string,
  fallbackModelId?: string,
): Promise<Model> => {
  const lastMessage = await getLastMessage(db, workspaceId, threadId)

  if (lastMessage?.modelId) {
    const model = await getModel(db, workspaceId, lastMessage.modelId)

    if (model && model.enabled) {
      return model
    }
  }

  if (fallbackModelId) {
    const model = await getModel(db, workspaceId, fallbackModelId)

    if (model && model.enabled) {
      return model
    }
  }

  return await getSelectedModel(db, workspaceId)
}

/**
 * Update a model in the given workspace (preserves defaultHash for modification tracking)
 */
export const updateModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  updates: Partial<Model>,
): Promise<void> => {
  // Strip `defaultHash` (preserved for modification tracking) and `workspaceId`
  // (the row stays in the workspace it was filtered to — callers can't reassign).
  const {
    defaultHash,
    apiKey,
    workspaceId: _workspaceId,
    ...updateFields
  } = updates as Partial<Model> & { defaultHash?: string }

  await db.transaction(async (tx) => {
    if (Object.keys(updateFields).length > 0) {
      await tx
        .update(modelsTable)
        .set(updateFields)
        .where(and(eq(modelsTable.id, id), eq(modelsTable.workspaceId, workspaceId)))
    }

    // PowerSync exposes local-only tables as SQLite views, which don't support
    // INSERT...ON CONFLICT DO UPDATE. Emulate UPSERT with SELECT-then-INSERT/UPDATE.
    if (apiKey !== undefined) {
      const existing = await tx.select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, id)).get()
      if (existing) {
        await tx.update(modelsSecretsTable).set({ apiKey }).where(eq(modelsSecretsTable.modelId, id))
      } else if (apiKey != null) {
        await tx.insert(modelsSecretsTable).values({ modelId: id, apiKey })
      }
    }
  })
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
  workspaceId: string,
  id: string,
  defaultModel: Model,
): Promise<void> => {
  const {
    defaultHash,
    apiKey,
    workspaceId: _seedWs,
    userId,
    ...defaultFields
  } = defaultModel as Model & {
    workspaceId?: string | null
  }
  await db.transaction(async (tx) => {
    await tx
      .update(modelsTable)
      .set({ ...defaultFields, defaultHash: hashModel(defaultModel) })
      .where(and(eq(modelsTable.id, id), eq(modelsTable.workspaceId, workspaceId)))
    await tx.delete(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, id))
  })
}

/**
 * Soft deletes a model by ID in the given workspace (sets deletedAt datetime).
 * Also soft-deletes all prompts referencing this model (and their triggers).
 * Scrubs all non-enum data for privacy. Only updates records that haven't been
 * deleted yet to preserve original deletion datetimes.
 */
export const deleteModel = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<void> => {
  // Dynamic import to avoid circular dependency: models -> prompts -> models (via getModel)
  const { deletePromptsForModel } = await import('./prompts')
  await db.transaction(async (tx) => {
    await deleteModelProfileForModel(tx, workspaceId, id)
    await deletePromptsForModel(tx, workspaceId, id)
    await tx.delete(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, id))
    await tx
      .update(modelsTable)
      .set({ ...clearNullableColumns(modelsTable), deletedAt: nowIso() })
      .where(and(eq(modelsTable.id, id), eq(modelsTable.workspaceId, workspaceId), isNull(modelsTable.deletedAt)))
  })
}

/**
 * Creates a new model in the given workspace. Defaults `scope` to `'workspace'`
 * when the caller doesn't set it explicitly; pass `scope: 'user'` with a
 * matching `userId` to make the row private to its author (THU-603).
 */
export const createModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: Partial<Model> & Pick<Model, 'id' | 'provider' | 'name' | 'model'>,
): Promise<void> => {
  const { apiKey, scope, ...modelData } = data
  await db.transaction(async (tx) => {
    await tx.insert(modelsTable).values({ ...modelData, workspaceId, scope: scope ?? 'workspace' })
    if (apiKey != null) {
      await tx.insert(modelsSecretsTable).values({ modelId: data.id, apiKey })
    }
    await createDefaultModelProfile(tx, workspaceId, data.id, scope ?? 'workspace')
  })
}
