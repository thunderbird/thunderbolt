/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { getIntegrationStatus, getSettings } from '@/dal'
import { getDb } from '@/db/database'
import * as tasksTools from '@/extensions/tasks/tools'
import { createConfigs as createGoogleConfigs } from '@/integrations/google/tools'
import { createConfigs as createMicrosoftConfigs } from '@/integrations/microsoft/tools'
import { createConfigs as createProConfigs } from '@/integrations/thunderbolt-pro/tools'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
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

  const baseTools: ToolConfig[] = experimentalFeatureTasks ? [...Object.values(tasksTools)] : []

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

export const createTool = (config: ToolConfig) => {
  return tool({
    description: config.description,
    inputSchema: config.parameters,
    execute: config.execute,
  })
}

export const createToolset = (tools: ToolConfig[]) => {
  return {
    ...tools.reduce(
      (acc, tool) => {
        acc[tool.name] = createTool(tool)
        return acc
      },
      {} as Record<string, Tool>,
    ),
  }
}
