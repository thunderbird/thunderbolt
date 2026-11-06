/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHtmlTool } from '@/artifacts/render-html-tool'
import type { HttpClient } from '@/contexts'
import { getIntegrationStatus, getSettings } from '@/dal'
import { getDb } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import * as tasksTools from '@/extensions/tasks/tools'
import { createConfigs as createGoogleConfigs } from '@/integrations/google/tools'
import { createConfigs as createMicrosoftConfigs } from '@/integrations/microsoft/tools'
import { createConfigs as createWebSearchTools } from '@/integrations/thunderbolt-pro/tools'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import { getSearchConnectionApi } from '@/integrations/standalone-search/connection'
import { resolveSearchSelection } from '@/integrations/standalone-search/selection'
import { hasServerAuthentication } from '@/lib/provider-mode'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { toolCallKey } from '@/lib/stable-stringify'
import type { WebToolBudget } from '@/ai/web-tool-budget'
import type { ToolConfig } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { tool, type Tool } from 'ai'

/** Construction-time snapshot of the settings and connection that gate exposed tools. */
export type ToolAvailabilityContext = {
  searchConnectionId?: string
  searchApi?: WebToolApi
  settings: { experimentalFeatureTasks: boolean; integrationsProIsEnabled: boolean }
  integrationStatus: Awaited<ReturnType<typeof getIntegrationStatus>>
}

/** Discover capabilities only for the explicitly selected connection. */
export const loadConnectedSearchApis = async (
  db: AnyDrizzleDatabase,
): Promise<Pick<ToolAvailabilityContext, 'searchConnectionId' | 'searchApi'>> => {
  const { selection, connectionId } = useSearchProviderStore.getState()
  if (selection !== 'connection' || !connectionId) {
    return {}
  }
  return { searchConnectionId: connectionId, searchApi: await getSearchConnectionApi(db, connectionId) }
}

/** The hot send path injects its already-loaded settings and integration status. */
const loadToolAvailabilityContext = async (): Promise<ToolAvailabilityContext> => {
  const db = getDb()
  const settings = await getSettings(db, {
    experimental_feature_tasks: false,
    integrations_pro_is_enabled: false,
  })
  const integrationStatus = await getIntegrationStatus(db)
  return { settings, integrationStatus, ...(await loadConnectedSearchApis(db)) }
}

export const getAvailableTools = async (
  httpClient: HttpClient,
  sourceCollector?: SourceMetadata[],
  context?: ToolAvailabilityContext,
): Promise<ToolConfig[]> => {
  const proEnabled = await hasProAccess()
  const {
    settings: { experimentalFeatureTasks, integrationsProIsEnabled },
    integrationStatus,
    searchApi,
    searchConnectionId,
  } = context ?? (await loadToolAvailabilityContext())
  const baseTools: ToolConfig[] = [renderHtmlTool, ...(experimentalFeatureTasks ? Object.values(tasksTools) : [])]
  const { selection, connectionId } = useSearchProviderStore.getState()
  const hasServer = hasServerAuthentication()
  const selected = resolveSearchSelection(selection, {
    connection: Boolean(searchApi && connectionId === searchConnectionId),
    cloud: hasServer && proEnabled && integrationsProIsEnabled,
  })
  if (selected) {
    const webTools = createWebSearchTools(
      httpClient,
      sourceCollector,
      selected === 'connection' ? searchApi : undefined,
    )
    baseTools.push(
      ...webTools.map((config) => ({
        ...config,
        execute: async (params: unknown) => {
          const cloudEnabled =
            selected === 'cloud'
              ? (await getSettings(getDb(), { integrations_pro_is_enabled: false })).integrationsProIsEnabled
              : false
          const current = useSearchProviderStore.getState()
          const currentSelection = resolveSearchSelection(current.selection, {
            connection: Boolean(searchApi && current.connectionId === searchConnectionId),
            cloud: hasServerAuthentication() && proEnabled && cloudEnabled,
          })
          if (currentSelection !== selected) {
            throw new Error(
              'Search provider changed or was disconnected. Start a new turn to use the current provider.',
            )
          }
          // Connection adapters resolve credentials on every call, enforcing disable, disconnect and rotation.
          return config.execute(params)
        },
      })),
    )
  }
  if (integrationStatus.googleEnabled) {
    baseTools.push(...createGoogleConfigs(httpClient))
  }
  if (integrationStatus.microsoftEnabled) {
    baseTools.push(...createMicrosoftConfigs(httpClient))
  }
  return baseTools
}

export const tools = [...Object.values(tasksTools)]

/**
 * Per-request memo of tool executions, keyed by tool name + finalized input.
 * Created fresh per streaming response in `aiFetchStreamingResponse`, so it
 * never spans conversation turns and needs no TTL or invalidation.
 */
export type ToolCallCache = Map<string, Promise<unknown>>

/** Built-in web tools governed by the production per-turn web budget. */
export const webToolNames: ReadonlySet<string> = new Set(['search', 'fetch_content'])

/**
 * Wrap a `cacheable` tool's executor so identical calls within one streaming
 * response reuse the first (in-flight or settled) result instead of
 * re-executing — removing duplicate round trips. The in-flight promise is
 * cached so concurrent identical calls share one request; a rejected execution
 * is evicted so the error surfaces and the next call re-runs (never cache a
 * failure).
 *
 * Note: AI SDK execute-options (abortSignal, messages, toolCallId) are NOT
 * forwarded to the wrapped executor — only `cacheable` read-only tools whose
 * execute ignores those options may opt in.
 */
const dedupedExecute =
  (config: ToolConfig, cache: ToolCallCache) =>
  (input: unknown): Promise<unknown> => {
    const key = toolCallKey(config.name, input)
    const cached = cache.get(key)
    if (cached) {
      return cached
    }
    const result = config.execute(input)
    cache.set(key, result)
    result.catch(() => cache.delete(key))
    return result
  }

const budgetedWebExecute =
  (config: ToolConfig, webToolBudget: WebToolBudget, execute: (input: unknown) => Promise<unknown>) =>
  (input: unknown): Promise<unknown> =>
    webToolBudget.execute(config.name, input, () => execute(input))

/**
 * Build an AI SDK tool from a {@link ToolConfig}. When a {@link ToolCallCache}
 * is supplied and the tool opts in via `cacheable` (deterministic, read-only),
 * its executor is wrapped to dedupe identical calls within the request. Tools
 * without `cacheable` (notably side-effecting/write tools) always execute.
 */
export const createTool = (config: ToolConfig, cache?: ToolCallCache, webToolBudget?: WebToolBudget) => {
  const execute = cache && config.cacheable ? dedupedExecute(config, cache) : config.execute
  return tool({
    description: config.description,
    inputSchema: config.parameters,
    toModelOutput:
      webToolBudget && webToolNames.has(config.name)
        ? ({ output }) => ({
            type: 'content',
            value: [
              { type: 'text', text: JSON.stringify(output) },
              {
                type: 'text',
                text: `Web calls remaining this turn: ${Math.max(0, webToolBudget.cap - webToolBudget.consumed)}.${webToolBudget.probe.isExhausted ? ' Synthesize now from the available evidence; do not call web tools again.' : ''}`,
              },
            ],
          })
        : undefined,
    execute:
      webToolBudget && webToolNames.has(config.name) ? budgetedWebExecute(config, webToolBudget, execute) : execute,
  })
}

export const createToolset = (
  tools: ToolConfig[],
  cache?: ToolCallCache,
  webToolBudget?: WebToolBudget,
): Record<string, Tool> =>
  tools.reduce<Record<string, Tool>>((acc, tool) => {
    acc[tool.name] = createTool(tool, cache, webToolBudget)
    return acc
  }, {})
