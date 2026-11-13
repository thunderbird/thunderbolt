/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { http } from '@/lib/http'
import { nativeFetch as desktopFetch } from '@/lib/native-fetch'
import { and, eq, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { modelsTable } from '@/db/tables'
import { createModelInTransaction } from '@/dal/models'
import { getProviderConnection, resolveProviderConnection } from '@/dal/provider-connections'
import { fetchModelsForProvider, type AvailableModel } from '@/settings/models/model-catalog'
import { getModelDisplayName } from '@/settings/models/model-display-name'
import { fetch as nativeFetch } from '@/lib/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import { getProviderDefinition } from './registry'
import type { Model } from '@/types'
import { getIdentitySignal } from '@/lib/identity-lifetime'

/** Discover a connection's model capability using current device credentials. */
export const fetchProviderModels = async (
  db: AnyDrizzleDatabase,
  connectionId: string,
  getProxyFetch: () => FetchFn = () => nativeFetch,
): Promise<AvailableModel[]> => {
  const signal = getIdentitySignal()
  const { connection, apiKey } = await resolveProviderConnection(db, connectionId)
  signal.throwIfAborted()
  if (!getProviderDefinition(connection.provider).capabilities.includes('models')) {
    throw new Error('This provider does not supply models')
  }
  if (connection.provider === 'openai' && connection.authMethod === 'oauth') {
    const catalog = z
      .object({
        models: z.array(z.object({ slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string() })),
      })
      .parse(
        await http
          .get('https://api.openai.com/v1/models', {
            fetch: desktopFetch,
            headers: { Authorization: `Bearer ${apiKey}` },
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          })
          .json(),
      )
    signal.throwIfAborted()
    return catalog.models
      .filter((model) => model.visibility === 'list')
      .map((model) => ({ id: model.slug, name: model.display_name }))
  }
  const models = await fetchModelsForProvider(
    { provider: connection.provider as Model['provider'], apiKey, url: connection.url ?? undefined, connectionId },
    getProxyFetch,
    signal,
  )
  signal.throwIfAborted()
  return models
}

/** Add selected models without duplicating credentials or overwriting existing model preferences. */
export const addProviderModels = async (
  db: AnyDrizzleDatabase,
  connectionId: string,
  models: AvailableModel[],
  { expectedUpdatedAt, signal }: { expectedUpdatedAt?: string | null; signal?: AbortSignal } = {},
): Promise<string[]> => {
  const operation = AbortSignal.any([getIdentitySignal(), ...(signal ? [signal] : [])])
  return db.transaction(async (tx) => {
    operation.throwIfAborted()
    const connection = await getProviderConnection(tx, connectionId)
    if (expectedUpdatedAt !== undefined && connection?.updatedAt !== expectedUpdatedAt) {
      throw new Error('The provider connection changed. Reload the model catalog.')
    }
    if (
      !connection?.connected ||
      connection.enabled !== 1 ||
      !getProviderDefinition(connection.provider).capabilities.includes('models')
    ) {
      throw new Error('Connect the provider before adding models')
    }
    const existing = await tx
      .select()
      .from(modelsTable)
      .where(and(eq(modelsTable.providerConnectionId, connectionId), isNull(modelsTable.deletedAt)))
    const ids: string[] = []
    for (const model of new Map(models.map((model) => [model.id, model])).values()) {
      if (!model.id.trim()) {
        throw new Error('A model ID is required')
      }
      const previous = existing.find((row) => row.model === model.id)
      if (previous) {
        ids.push(previous.id)
        continue
      }
      const id = crypto.randomUUID()
      await createModelInTransaction(tx, {
        id,
        providerConnectionId: connectionId,
        provider: connection.provider as Model['provider'],
        name: getModelDisplayName(model),
        model: model.id,
        url: null,
        isSystem: 0,
        enabled: 1,
        toolUsage: model.supports_tools === false ? 0 : 1,
        isConfidential: getProviderDefinition(connection.provider).attested ? 1 : 0,
      })
      ids.push(id)
    }
    operation.throwIfAborted()
    return ids
  })
}
