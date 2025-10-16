import * as tasksTools from '@/extensions/tasks/tools'
import type { FlowerTool } from '@/flower'
import { configs as googleConfigs } from '@/integrations/google/tools'
import { configs as microsoftConfigs } from '@/integrations/microsoft/tools'
import { configs as proConfigs } from '@/integrations/thunderbolt-pro/tools'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import { getSettings } from '@/dal'
import type { ToolConfig } from '@/types'
import { zodSchema } from '@ai-sdk/provider-utils'
import { tool, type Tool } from 'ai'

export const getAvailableTools = async (): Promise<ToolConfig[]> => {
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
    baseTools.push(...proConfigs)
  }

  if (integrationsGoogleIsEnabled) {
    baseTools.push(...googleConfigs)
  }

  if (integrationsMicrosoftIsEnabled) {
    baseTools.push(...microsoftConfigs)
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

/**
 * Creates a toolset of Flower tools from an array of ToolConfig objects.
 *
 * This function converts multiple ToolConfig objects into an array of Flower Tool objects
 * compatible with Flower Intelligence.
 *
 * @param tools - Array of ToolConfig objects to convert
 * @returns Array of Flower Tool objects
 */
export const createFlowerToolset = (tools: ToolConfig[]): FlowerTool[] => {
  return tools.map(createFlowerTool)
}

/**
 * Creates a Flower Tool from a ToolConfig object.
 *
 * This function converts the internal ToolConfig format (which uses Zod schemas for parameters)
 * to the Flower Tool format that is compatible with Flower Intelligence tools.
 *
 * The resulting tool can be used with Flower's chat system and will properly handle
 * parameter validation and type checking.
 *
 * @param config - The ToolConfig to convert (contains name, description, and Zod parameter schema)
 * @returns A valid Flower Tool object that can be used with Flower Intelligence
 */
export const createFlowerTool = (config: ToolConfig): FlowerTool => {
  const schema = zodSchema(config.parameters)

  return {
    type: 'function',
    function: {
      name: config.name,
      description: config.description,
      parameters: schema.jsonSchema as any, // The jsonSchema property contains the proper format
    },
  }
}
