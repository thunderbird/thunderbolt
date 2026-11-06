/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { integrationsSecretsTable, providerConnectionsTable, providerConnectionSecretsTable } from '@/db/tables'
import { getModel } from '@/dal/models'
import { getProviderConnections } from '@/dal/provider-connections'
import { migrateLegacyProviderCredential } from './provider-connections'
import { searchProviders } from '@/integrations/standalone-search/providers'
import {
  legacySearchStorageKey,
  searchSelectionStorageKey,
  useSearchProviderStore,
} from '@/stores/search-provider-store'

export { legacySearchStorageKey } from '@/stores/search-provider-store'
const legacyState = z.object({
  state: z.object({
    selection: z.enum(['auto', 'custom', 'tinfoil', 'otari', 'cloud', 'none']).default('auto'),
    provider: z.enum(['exa', 'brave', 'tavily']).nullable().optional(),
    apiKey: z.string().optional(),
    otariConnection: z
      .object({
        modelId: z.string(),
        url: z.string(),
        searchStatus: z.enum(['available', 'not_configured', 'workspace_disabled', 'unknown']),
      })
      .nullable()
      .optional(),
  }),
})

/** Move legacy localStorage keys only after their durable, idempotent connection write succeeds. */
export const migrateSearchProviderConnections = async (db: AnyDrizzleDatabase): Promise<void> => {
  const raw = localStorage.getItem(legacySearchStorageKey)
  const alreadySelected = localStorage.getItem(searchSelectionStorageKey) !== null
  if (!raw && alreadySelected) {
    return
  }
  const legacy: z.infer<typeof legacyState>['state'] = (() => {
    if (!raw) {
      return { selection: 'auto' as const }
    }
    try {
      return legacyState.parse(JSON.parse(raw)).state
    } catch {
      throw new Error('The legacy search configuration could not be read')
    }
  })()
  const apiKey = legacy.apiKey?.trim() ?? ''
  const provider = legacy.provider
  const customId = provider && apiKey ? `legacy-search:${provider}` : null
  const migrated =
    customId && provider
      ? await db.transaction((tx) =>
          migrateLegacyProviderCredential(tx, {
            id: customId,
            provider,
            name: searchProviders[provider].name,
            url: null,
            authMethod: 'api_key',
            credentials: { apiKey },
          }),
        )
      : true
  if (!alreadySelected) {
    const connections = await getProviderConnections(db)
    const tinfoil =
      connections.find((connection) => connection.id === 'oauth:tinfoil' && connection.connected) ??
      connections.find((connection) => connection.provider === 'tinfoil' && connection.connected)
    // Only device-local credential history implies private-search intent. Synced
    // metadata alone does not; disconnected/expired credentials still do.
    const localTinfoil = await db
      .select({ id: providerConnectionsTable.id })
      .from(providerConnectionsTable)
      .innerJoin(providerConnectionSecretsTable, eq(providerConnectionSecretsTable.id, providerConnectionsTable.id))
      .where(eq(providerConnectionsTable.provider, 'tinfoil'))
      .orderBy(providerConnectionsTable.id)
    const legacyTinfoil = await db
      .select({ provider: integrationsSecretsTable.provider })
      .from(integrationsSecretsTable)
      .where(and(eq(integrationsSecretsTable.provider, 'tinfoil'), isNotNull(integrationsSecretsTable.credentials)))
      .get()
    const tinfoilId =
      tinfoil?.id ??
      localTinfoil.find(({ id }) => id === 'oauth:tinfoil')?.id ??
      localTinfoil[0]?.id ??
      (legacyTinfoil ? 'oauth:tinfoil' : null)
    const otariId = legacy.otariConnection
      ? ((await getModel(db, legacy.otariConnection.modelId))?.providerConnectionId ??
        `legacy-model:${legacy.otariConnection.modelId}`)
      : null
    const selection = legacy.selection
    const id = {
      custom: customId,
      tinfoil: tinfoilId ?? 'oauth:tinfoil',
      otari: otariId ?? 'oauth:otari',
      auto: customId ?? tinfoilId ?? otariId,
      cloud: null,
      none: null,
    }[selection]
    useSearchProviderStore.setState({
      selection:
        id || ['custom', 'tinfoil', 'otari'].includes(selection)
          ? 'connection'
          : selection === 'none' || selection === 'cloud'
            ? selection
            : 'auto',
      connectionId: id ?? null,
      connectionStatus:
        otariId && legacy.otariConnection
          ? { connectionId: otariId, status: legacy.otariConnection.searchStatus }
          : null,
    })
  }
  if (migrated) {
    localStorage.removeItem(legacySearchStorageKey)
  }
}
