/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { integrationsSecretsTable } from '../db/tables'

type IntegrationProvider = 'google' | 'microsoft'

type IntegrationCredentials = {
  access_token: string
  refresh_token?: string
  expires_at?: number
  profile?: {
    email: string
    name: string
    picture?: string
  }
}

type IntegrationRow = {
  credentials: IntegrationCredentials
  enabled: boolean
}

/** Get credentials and enabled flag for a provider. Returns null if no row exists. */
export const getIntegrationCredentials = async (
  db: AnyDrizzleDatabase,
  provider: IntegrationProvider,
): Promise<IntegrationRow | null> => {
  const row = await db
    .select()
    .from(integrationsSecretsTable)
    .where(eq(integrationsSecretsTable.provider, provider))
    .get()

  if (!row?.credentials) {
    return null
  }

  try {
    return {
      credentials: JSON.parse(row.credentials) as IntegrationCredentials,
      enabled: row.enabled === 1,
    }
  } catch {
    return null
  }
}

/**
 * Save credentials for a provider (insert or update).
 * Uses SELECT-then-INSERT-or-UPDATE because PowerSync local-only tables are views that don't support UPSERT.
 */
export const saveIntegrationCredentials = async (
  db: AnyDrizzleDatabase,
  provider: IntegrationProvider,
  credentials: IntegrationCredentials,
  enabled: boolean,
): Promise<void> => {
  const json = JSON.stringify(credentials)
  const existing = await db
    .select()
    .from(integrationsSecretsTable)
    .where(eq(integrationsSecretsTable.provider, provider))
    .get()

  if (existing) {
    await db
      .update(integrationsSecretsTable)
      .set({ credentials: json, enabled: enabled ? 1 : 0 })
      .where(eq(integrationsSecretsTable.provider, provider))
  } else {
    await db.insert(integrationsSecretsTable).values({
      provider,
      credentials: json,
      enabled: enabled ? 1 : 0,
    })
  }
}

/** Toggle the enabled flag for a provider without changing credentials. */
export const setIntegrationEnabled = async (
  db: AnyDrizzleDatabase,
  provider: IntegrationProvider,
  enabled: boolean,
): Promise<void> => {
  await db
    .update(integrationsSecretsTable)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(integrationsSecretsTable.provider, provider))
}

/** Delete credentials for a provider (disconnect). */
export const deleteIntegrationCredentials = async (
  db: AnyDrizzleDatabase,
  provider: IntegrationProvider,
): Promise<void> => {
  await db.delete(integrationsSecretsTable).where(eq(integrationsSecretsTable.provider, provider))
}

/** Get connection/enabled status for all integration providers. */
export const getIntegrationStatus = async (
  db: AnyDrizzleDatabase,
): Promise<{
  googleConnected: boolean
  googleEnabled: boolean
  microsoftConnected: boolean
  microsoftEnabled: boolean
}> => {
  const rows = await db.select().from(integrationsSecretsTable).all()

  const google = rows.find((r) => r.provider === 'google')
  const microsoft = rows.find((r) => r.provider === 'microsoft')

  return {
    googleConnected: !!google?.credentials,
    googleEnabled: google?.enabled === 1,
    microsoftConnected: !!microsoft?.credentials,
    microsoftEnabled: microsoft?.enabled === 1,
  }
}
