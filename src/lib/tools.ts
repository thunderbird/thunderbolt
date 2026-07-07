/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHtmlTool } from '@/artifacts/render-html-tool'
import type { HttpClient } from '@/contexts'
import { getIntegrationStatus, getSettings } from '@/dal'
import { getDb } from '@/db/database'
import * as tasksTools from '@/extensions/tasks/tools'
import { createConfigs as createGoogleConfigs } from '@/integrations/google/tools'
import { createConfigs as createMicrosoftConfigs } from '@/integrations/microsoft/tools'
import { createConfigs as createProConfigs } from '@/integrations/thunderbolt-pro/tools'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import { toolCallKey } from '@/lib/stable-stringify'
import type { ToolConfig } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { tool, type Tool } from 'ai'

/** Settings + integration status that gate which tools are exposed. */
export type ToolAvailabilityContext = {
  settings: { experimentalFeatureTasks: boolean; integrationsProIsEnabled: boolean }
  integrationStatus: Awaited<ReturnType<typeof getIntegrationStatus>>
}

/** Read the settings + integration status that gate tool availability. The hot
 *  send path (`aiFetchStreamingResponse`) already fetches both, so it injects
 *  them to avoid duplicate DB round-trips; other callers let this self-fetch. */
const loadToolAvailabilityContext = async (): Promise<ToolAvailabilityContext> => {
  const db = getDb()
  const settings = await getSettings(db, {
    experimental_feature_tasks: false,
    integrations_pro_is_enabled: false,
  })
  const integrationStatus = await getIntegrationStatus(db)
  return { settings, integrationStatus }
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
  } = context ?? (await loadToolAvailabilityContext())

  // render_html is a core capability, always available regardless of integrations.
  const baseTools: ToolConfig[] = [renderHtmlTool, ...(experimentalFeatureTasks ? Object.values(tasksTools) : [])]

  const shouldIncludeProTools = proEnabled && integrationsProIsEnabled

  if (shouldIncludeProTools) {
    baseTools.push(...createProConfigs(httpClient, sourceCollector))
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

/**
 * Build an AI SDK tool from a {@link ToolConfig}. When a {@link ToolCallCache}
 * is supplied and the tool opts in via `cacheable` (deterministic, read-only),
 * its executor is wrapped to dedupe identical calls within the request. Tools
 * without `cacheable` (notably side-effecting/write tools) always execute.
 */
export const createTool = (config: ToolConfig, cache?: ToolCallCache) =>
  tool({
    description: config.description,
    inputSchema: config.parameters,
    execute: cache && config.cacheable ? dedupedExecute(config, cache) : config.execute,
  })

export const createToolset = (tools: ToolConfig[], cache?: ToolCallCache): Record<string, Tool> =>
  tools.reduce<Record<string, Tool>>((acc, tool) => {
    acc[tool.name] = createTool(tool, cache)
    return acc
  }, {})
