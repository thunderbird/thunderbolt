import type { HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import * as tasksTools from '@/extensions/tasks/tools'
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
  const proEnabled = await hasProAccess()
  const {
    experimentalFeatureTasks,
    integrationsProIsEnabled,
    integrationsGoogleIsEnabled,
    integrationsMicrosoftIsEnabled,
  } = await getSettings({
    experimental_feature_tasks: false,
    integrations_pro_is_enabled: false,
    integrations_google_is_enabled: false,
    integrations_microsoft_is_enabled: false,
  })

  const baseTools: ToolConfig[] = experimentalFeatureTasks ? [...Object.values(tasksTools)] : []

  const shouldIncludeProTools = proEnabled && integrationsProIsEnabled

  if (shouldIncludeProTools) {
    baseTools.push(...createProConfigs(httpClient, sourceCollector))
  }

  if (integrationsGoogleIsEnabled) {
    baseTools.push(...createGoogleConfigs(httpClient))
  }

  if (integrationsMicrosoftIsEnabled) {
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
