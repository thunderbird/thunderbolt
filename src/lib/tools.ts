import type { HttpClient } from '@/contexts'
import { getIntegrationStatuses, getSettings } from '@/dal'
import * as tasksTools from '@/extensions/tasks/tools'
import { createConfigs as createGoogleConfigs } from '@/integrations/google/tools'
import { createConfigs as createMicrosoftConfigs } from '@/integrations/microsoft/tools'
import { createConfigs as createProConfigs } from '@/integrations/thunderbolt-pro/tools'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import type { ToolConfig } from '@/types'
import { tool, type Tool } from 'ai'

export const getAvailableTools = async (httpClient: HttpClient): Promise<ToolConfig[]> => {
  // Check Thunderbolt Pro access and integration enabled state
  const proEnabled = await hasProAccess()
  const { experimentalFeatureTasks, integrationsProIsEnabled } = await getSettings({
    experimental_feature_tasks: false,
    integrations_pro_is_enabled: false,
  })
  const integrations = await getIntegrationStatuses()

  const baseTools: ToolConfig[] = experimentalFeatureTasks ? [...Object.values(tasksTools)] : []

  const shouldIncludeProTools = proEnabled && integrationsProIsEnabled

  if (shouldIncludeProTools) {
    baseTools.push(...createProConfigs(httpClient))
  }

  if (integrations.google?.enabled) {
    baseTools.push(...createGoogleConfigs(httpClient))
  }

  if (integrations.microsoft?.enabled) {
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
