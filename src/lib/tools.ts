/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { getIntegrationStatus, getSettings } from '@/dal'
import { getDb } from '@/db/database'
import * as tasksTools from '@/extensions/tasks/tools'
import { createConfigs as createCodingAgentConfigs } from '@/integrations/coding-agent/tools'
import { createConfigs as createGoogleConfigs } from '@/integrations/google/tools'
import { createConfigs as createMicrosoftConfigs } from '@/integrations/microsoft/tools'
import { createConfigs as createProConfigs } from '@/integrations/thunderbolt-pro/tools'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import type { ToolConfig } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { tool, type Tool } from 'ai'

export const getAvailableTools = async (
  httpClient: HttpClient,
  sourceCollector?: SourceMetadata[],
): Promise<ToolConfig[]> => {
  // Check Thunderbolt Pro access and integration enabled state
  const db = getDb()
  const proEnabled = await hasProAccess()
  const { experimentalFeatureTasks, integrationsProIsEnabled } = await getSettings(db, {
    experimental_feature_tasks: false,
    integrations_pro_is_enabled: false,
  })
  const integrationStatus = await getIntegrationStatus(db)

  const baseTools: ToolConfig[] = experimentalFeatureTasks ? [...Object.values(tasksTools)] : []

  // Coding-agent GitHub connect/status. Always offered: the backend reports
  // `configured: false` cleanly when the broker isn't wired, so the assistant can
  // tell the user it's unavailable rather than the tool simply not existing.
  baseTools.push(...createCodingAgentConfigs(httpClient))

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
