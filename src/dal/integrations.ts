/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { integrationsSecretsTable } from '../db/tables'
import type { OAuthProvider } from '../lib/auth'
import { readOAuthCredentials, writeOAuthCredentials } from '@/providers/credentials'

type CredentialProvider = OAuthProvider | 'tinfoil' | 'openrouter' | 'otari'

type IntegrationCredentials = {
  oauthRelayUrl?: string
  access_token: string
  refresh_token?: string
  expires_at?: number
  reauth_required?: boolean
  /** Local generation invalidates OAuth attempts started before a connection change. */
  sessionRevision?: string
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
  provider: CredentialProvider,
): Promise<IntegrationRow | null> => {
  if (provider === 'tinfoil' || provider === 'openrouter' || provider === 'otari') {
    const connection = await readOAuthCredentials(db, provider)
    if (connection) {
      return connection
    }
  }
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
  provider: CredentialProvider,
  credentials: IntegrationCredentials,
  enabled: boolean,
  preserveEnabled = false,
): Promise<void> => {
  if (provider === 'tinfoil' || provider === 'openrouter' || provider === 'otari') {
    if (await writeOAuthCredentials(db, provider, credentials, enabled, preserveEnabled)) {
      return
    }
  }
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

/**
 * Update credentials for a provider without changing the enabled flag.
 * Compare the credential snapshot so a refresh cannot overwrite a reconnect or restore a disconnected account.
 */
export const updateIntegrationCredentials = async (
  db: AnyDrizzleDatabase,
  provider: CredentialProvider,
  credentials: IntegrationCredentials,
  previous: IntegrationCredentials,
): Promise<void> => {
  const changed = await db
    .update(integrationsSecretsTable)
    .set({ credentials: JSON.stringify(credentials) })
    .where(
      and(
        eq(integrationsSecretsTable.provider, provider),
        eq(integrationsSecretsTable.credentials, JSON.stringify(previous)),
        eq(integrationsSecretsTable.enabled, 1),
      ),
    )
    .returning({ provider: integrationsSecretsTable.provider })
  if (changed.length === 0) {
    throw new Error('The integration changed during token refresh. Try again.')
  }
}

/** Toggle the enabled flag for a provider without changing credentials. */
export const setIntegrationEnabled = async (
  db: AnyDrizzleDatabase,
  provider: CredentialProvider,
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
  provider: CredentialProvider,
): Promise<void> => {
  await db.delete(integrationsSecretsTable).where(eq(integrationsSecretsTable.provider, provider))
}

const parseEmail = (raw: string | null | undefined): string | null => {
  if (!raw) {
    return null
  }
  try {
    return (JSON.parse(raw) as IntegrationCredentials).profile?.email ?? null
  } catch {
    return null
  }
}

/** Get connection/enabled status for all integration providers. */
export const getIntegrationStatus = async (
  db: AnyDrizzleDatabase,
): Promise<{
  googleConnected: boolean
  googleEnabled: boolean
  googleEmail: string | null
  microsoftConnected: boolean
  microsoftEnabled: boolean
  microsoftEmail: string | null
}> => {
  const rows = await db.select().from(integrationsSecretsTable).all()

  const google = rows.find((r) => r.provider === 'google')
  const microsoft = rows.find((r) => r.provider === 'microsoft')

  return {
    googleConnected: !!google?.credentials,
    googleEnabled: google?.enabled === 1,
    googleEmail: parseEmail(google?.credentials),
    microsoftConnected: !!microsoft?.credentials,
    microsoftEnabled: microsoft?.enabled === 1,
    microsoftEmail: parseEmail(microsoft?.credentials),
  }
}
