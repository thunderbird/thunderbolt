/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { providersSecretsTable, providersTable } from '../db/tables'
import { nowIso } from '../lib/utils'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import type { ProviderCapability, ProviderType } from '../../shared/providers'

/** Synced provider row (metadata only, no secret). */
export type Provider = typeof providersTable.$inferSelect

/**
 * Credential blob stored on-device for a provider. Never synced. Most providers
 * (including OpenRouter's PKCE flow, which exchanges the code for a durable user
 * API key) resolve to `apiKey`; the OAuth token fields are kept for providers
 * that hand back refreshable tokens.
 */
export type ProviderCredentials = {
  apiKey?: string
  access_token?: string
  refresh_token?: string
  expires_at?: number // epoch ms
}

/** Query for all non-deleted providers in the given workspace (synced via PowerSync), alpha by type. */
export const getAllProviders = (db: AnyDrizzleDatabase, workspaceId: string) =>
  db
    .select()
    .from(providersTable)
    .where(and(eq(providersTable.workspaceId, workspaceId), isNull(providersTable.deletedAt)))
    .orderBy(asc(providersTable.type))

/** Fetch a single provider row by id within a workspace (non-deleted). Returns null when absent. */
export const getProviderById = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
): Promise<Provider | null> => {
  const row = await db
    .select()
    .from(providersTable)
    .where(
      and(eq(providersTable.id, id), eq(providersTable.workspaceId, workspaceId), isNull(providersTable.deletedAt)),
    )
    .get()
  return row ?? null
}

/** Live hook for providers in the active workspace. */
export const useProviders = (): Provider[] => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const { data = [] } = useQuery({
    queryKey: ['providers', workspaceId],
    query: toCompilableQuery(getAllProviders(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })
  return data
}

/** Fields accepted by `createProvider`. `id` is caller-generated (uuid). */
export type CreateProviderInput = {
  id: string
  type: ProviderType
  label?: string | null
  baseUrl?: string | null
  enabledCapabilities: ProviderCapability[]
  enabled?: 0 | 1
  userId: string
  /** Per-row visibility (THU-603). `'workspace'` shares; `'user'` keeps private. */
  scope?: 'workspace' | 'user'
}

/** Insert a new provider connection into the synced table in the given workspace. */
export const createProvider = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: CreateProviderInput,
): Promise<void> => {
  await db.insert(providersTable).values({
    id: data.id,
    type: data.type,
    label: data.label ?? null,
    baseUrl: data.baseUrl ?? null,
    enabledCapabilities: data.enabledCapabilities,
    enabled: data.enabled ?? 1,
    userId: data.userId,
    workspaceId,
    scope: data.scope ?? 'workspace',
  })
}

/** Fields patchable via `updateProvider`. `id`/`type`/`userId`/`deletedAt` are managed internally. */
export type UpdateProviderPatch = Partial<
  Pick<CreateProviderInput, 'label' | 'baseUrl' | 'enabledCapabilities' | 'enabled' | 'scope'>
>

/** Patch an existing provider connection. */
export const updateProvider = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  patch: UpdateProviderPatch,
): Promise<void> => {
  if (Object.keys(patch).length === 0) {
    return
  }
  await db
    .update(providersTable)
    .set(patch)
    .where(
      and(eq(providersTable.id, id), eq(providersTable.workspaceId, workspaceId), isNull(providersTable.deletedAt)),
    )
}

/**
 * Disconnect a provider: soft-delete the synced metadata row (tombstone
 * replicates) and hard-delete the local-only credential (device-local secret
 * removal is by design, like device/account removal). Models that referenced
 * this provider remain but will surface as needing a key until reconnected.
 */
export const deleteProvider = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<void> => {
  await db
    .update(providersTable)
    .set({ deletedAt: nowIso() })
    .where(
      and(eq(providersTable.id, id), eq(providersTable.workspaceId, workspaceId), isNull(providersTable.deletedAt)),
    )

  await deleteProviderCredentials(db, id)
}

/** Read credentials for a provider from the local-only secrets table. Returns null when no row exists. */
export const getProviderCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
): Promise<ProviderCredentials | null> => {
  const row = await db.select().from(providersSecretsTable).where(eq(providersSecretsTable.providerId, id)).get()
  if (!row?.credentials) {
    return null
  }
  return JSON.parse(row.credentials) as ProviderCredentials
}

/**
 * Save credentials for a provider (insert or update). SELECT-then-INSERT/UPDATE
 * because PowerSync local-only tables are views without UPSERT — same pattern as
 * `mcp_secrets` / `agents_secrets` / `integrations_secrets`.
 */
export const setProviderCredentials = async (
  db: AnyDrizzleDatabase,
  id: string,
  credentials: ProviderCredentials,
): Promise<void> => {
  const json = JSON.stringify(credentials)
  const existing = await db.select().from(providersSecretsTable).where(eq(providersSecretsTable.providerId, id)).get()

  if (existing) {
    await db.update(providersSecretsTable).set({ credentials: json }).where(eq(providersSecretsTable.providerId, id))
  } else {
    await db.insert(providersSecretsTable).values({ providerId: id, credentials: json })
  }
}

/** Delete credentials for a provider. */
export const deleteProviderCredentials = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.delete(providersSecretsTable).where(eq(providersSecretsTable.providerId, id))
}
