/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, inArray } from 'drizzle-orm'
import { SecureClient } from 'tinfoil'
import { z } from 'zod'
import type { Settings } from '@/config/settings'
import { cloudConversations, cloudRuns } from '@/db/cloud-agent-schema'
import { loadInferencePrice } from '@/inference/usage-ledger'
import { defaultModelDeepSeekV41Flash } from '@shared/defaults/models'
import type { CloudModel } from '@shared/cloud-agent/contracts'
import { indexScopedValue } from '@shared/cloud-agent/crypto'
import type { CloudAgentService } from './service'
import { activeRunStatuses } from './service'
import type { ArtifactService } from './artifacts'
import { createCloudTools } from './tools'
import { createBoundConnectionFetch, createConnectionFetch } from './connections'
import { refreshCloudConnection } from './oauth'
import { CloudError } from './errors'
import type { CloudModelCredentials } from './models'

/** Reuse the deployment's confidential model; user connections remain an explicit alternative. */
export const managedCloudModel = (settings: Settings): CloudModel | null =>
  settings.tinfoilApiKey
    ? {
        provider: 'managed',
        modelId: defaultModelDeepSeekV41Flash.model,
        contextWindow: defaultModelDeepSeekV41Flash.contextWindow ?? 131072,
        maxOutputTokens: 8192,
      }
    : null

/** Bind orchestration to authenticated application records without teaching the runtime HTTP or auth. */
export const createRuntimeHost = (
  service: CloudAgentService,
  artifacts: ArtifactService | null,
  settings: Settings,
) => {
  const resolveModel = async (
    loaded: Pick<Awaited<ReturnType<CloudAgentService['loadRun']>>, 'run' | 'config' | 'key'>,
  ): Promise<CloudModelCredentials> => {
    const { run, config, key } = loaded
    if (config.model.provider === 'managed') {
      const price = await loadInferencePrice(service.database, { provider: 'tinfoil', model: config.model.modelId })
      if (!price || !settings.tinfoilApiKey) {
        throw new CloudError(503, 'managed_model_unavailable')
      }
      const userCacheSecret = await indexScopedValue('model-cache', key, {
        ownerId: run.userId,
        scopeId: `agent:${run.agentId}`,
        keyEpoch: run.keyEpoch,
        purpose: 'provider-cache-isolation',
      })
      const secure = new SecureClient({ userCacheSecret })
      try {
        await secure.ready()
      } catch {
        throw new CloudError(503, 'managed_model_unavailable')
      }
      const input = Number(price.inputNanoUsdPerToken) / 1000
      const output = Number(price.outputNanoUsdPerToken) / 1000
      return {
        apiKey: settings.tinfoilApiKey,
        baseUrl: secure.getBaseURL()!,
        fetch: Object.assign(secure.fetch, { preconnect: fetch.preconnect }),
        api: 'openai-completions',
        cost: {
          input,
          output,
          cacheRead: Number(price.cacheReadNanoUsdPerToken ?? price.inputNanoUsdPerToken) / 1000,
          cacheWrite: input,
        },
      }
    }
    if (!config.model.connectionId) {
      throw new CloudError(422, 'model_connection_required')
    }
    const connection = await refreshCloudConnection(
      service,
      await service.getConnection(run.userId, config.model.connectionId),
    )
    if (!connection.enabled) {
      throw new CloudError(409, 'model_connection_disabled')
    }
    const { config: credentials } = await service.openConnection(connection)
    if (credentials.kind !== 'model') {
      throw new CloudError(422, 'model_connection_required')
    }
    const authentication = credentials.authentication
    if (
      authentication.type === 'oauth' &&
      authentication.expiresAt &&
      Date.parse(authentication.expiresAt) <= Date.now()
    ) {
      throw new CloudError(409, 'connection_authorization_expired')
    }
    const apiKey =
      authentication.type === 'none'
        ? 'keyless'
        : authentication.type === 'bearer'
          ? authentication.token
          : authentication.accessToken
    const input = config.model.inputCostPerMillion
    const output = config.model.outputCostPerMillion
    if (!input || !output) {
      throw new CloudError(422, 'model_pricing_required')
    }
    const upstream = createConnectionFetch(new URL(credentials.url).origin)
    const authorizedFetch = createBoundConnectionFetch(
      connection,
      async () => {
        await service.checkExecution(run.id)
        const agent = await service.getAgent(run.userId, run.agentId)
        const { config: current } = await service.openAgent(agent)
        if (current.model?.connectionId !== connection.id) {
          throw new CloudError(409, 'connection_grant_changed')
        }
        return refreshCloudConnection(service, connection)
      },
      upstream,
    )
    return {
      apiKey,
      baseUrl: credentials.url,
      fetch: authorizedFetch,
      api: config.model.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      cost: { input, output, cacheRead: input, cacheWrite: input * 2 },
    }
  }
  return {
    loadRun: async (runId: string) => {
      const loaded = await service.loadRun(runId)
      const conversation = await service.getConversation(loaded.run.userId, loaded.run.conversationId)
      return { ...loaded, piConversationId: conversation.piConversationId }
    },
    setStatus: service.setStatus,
    appendMessage: service.appendMessage,
    beforeTool: (runId: string, callId: string, name: string, args: unknown, signal?: AbortSignal) =>
      service.beforeTool(runId, callId, name, z.record(z.string(), z.unknown()).parse(args), signal),
    checkExecution: async (runId: string) => {
      await service.checkExecution(runId)
      const { run, config } = await service.loadRun(runId)
      if (config.model.connectionId) {
        const connection = await service.getConnection(run.userId, config.model.connectionId)
        if (!connection.enabled) {
          throw new CloudError(409, 'model_connection_disabled')
        }
      }
    },
    settleCost: async (runId: string, chargedMicros: number) => {
      await service.database
        .update(cloudRuns)
        .set({ spentMicros: Math.ceil(chargedMicros) })
        .where(eq(cloudRuns.id, runId))
    },
    activeRunIds: async (agentId: string) =>
      (
        await service.database
          .select({ id: cloudRuns.id })
          .from(cloudRuns)
          .where(
            and(
              eq(cloudRuns.agentId, agentId),
              inArray(
                cloudRuns.status,
                activeRunStatuses.filter((status) => status !== 'queued'),
              ),
            ),
          )
      ).map((row) => row.id),
    bindConversation: async (runId: string, piConversationId: number) => {
      const { run } = await service.loadRun(runId)
      await service.database
        .update(cloudConversations)
        .set({ piConversationId })
        .where(eq(cloudConversations.id, run.conversationId))
    },
    bindSubmission: async (runId: string, piSubmissionId: number) => {
      await service.database.update(cloudRuns).set({ piSubmissionId }).where(eq(cloudRuns.id, runId))
    },
    createTools: (loaded: Pick<Awaited<ReturnType<CloudAgentService['loadRun']>>, 'run' | 'config'>) =>
      createCloudTools(service, artifacts, loaded),
    resolveModel,
  }
}
