/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createModel, deleteModel } from '@/dal/models'
import { modelsTable } from '@/db/tables'
import { getProviderDefinition, type ProviderType } from '../../../shared/providers'
import type { CatalogModel } from './validate'

/**
 * The bridge between a provider's live catalog (thousands of models, not stored)
 * and the curated `modelsTable` (a row ⟺ the model is in the chat selector).
 * Flip a catalog model ON → upsert a `modelsTable` row; flip OFF → soft-delete.
 */

/** Find the active `modelsTable` row for a provider catalog entry, if any. */
export const findModelRowForCatalogEntry = (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  providerId: string,
  modelId: string,
) =>
  db
    .select()
    .from(modelsTable)
    .where(
      and(
        eq(modelsTable.workspaceId, workspaceId),
        eq(modelsTable.providerId, providerId),
        eq(modelsTable.model, modelId),
        isNull(modelsTable.deletedAt),
      ),
    )
    .get()

export type EnableCatalogModelInput = {
  providerId: string
  providerType: ProviderType
  catalogModel: CatalogModel
  userId: string
  scope?: 'workspace' | 'user'
}

/** Enable a catalog model: create a curated `modelsTable` row (idempotent — a
 *  row already showing this model is returned as-is). Returns the model row id. */
export const enableCatalogModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  input: EnableCatalogModelInput,
): Promise<string> => {
  const existing = await findModelRowForCatalogEntry(db, workspaceId, input.providerId, input.catalogModel.id)
  if (existing) {
    return existing.id
  }
  const def = getProviderDefinition(input.providerType)
  if (!def.models) {
    throw new Error(`Provider "${input.providerType}" has no models capability`)
  }
  const id = uuidv7()
  await createModel(db, workspaceId, {
    id,
    provider: def.models.modelProvider,
    providerId: input.providerId,
    name: input.catalogModel.name ?? input.catalogModel.id,
    model: input.catalogModel.id,
    enabled: 1,
    contextWindow: input.catalogModel.contextWindow ?? null,
    userId: input.userId,
    scope: input.scope,
  })
  return id
}

/** Disable a catalog model: soft-delete its curated row (no-op if not present). */
export const disableCatalogModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  providerId: string,
  modelId: string,
): Promise<void> => {
  const existing = await findModelRowForCatalogEntry(db, workspaceId, providerId, modelId)
  if (existing) {
    await deleteModel(db, workspaceId, existing.id)
  }
}

/** Toggle a catalog model on/off. */
export const toggleCatalogModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  input: EnableCatalogModelInput,
  on: boolean,
): Promise<void> => {
  if (on) {
    await enableCatalogModel(db, workspaceId, input)
  } else {
    await disableCatalogModel(db, workspaceId, input.providerId, input.catalogModel.id)
  }
}
