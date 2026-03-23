import type { SessionConfigOption, SessionMode } from '@agentclientprotocol/sdk'
import type { Mode, Model } from '@/types'
import type { AgentSessionState } from './types'

const acpModeDefaults = {
  systemPrompt: null,
  isDefault: 0,
  order: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
} as const

const acpModelDefaults = {
  vendor: null,
  contextWindow: null,
  isConfidential: 0,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  url: null,
  provider: 'custom' as const,
  apiKey: null,
  toolUsage: 1,
  startWithReasoning: 0,
  supportsParallelToolCalls: 1,
} as const

/** Convert an ACP SessionMode to a Mode object. */
export const modeFromSessionMode = (sessionMode: SessionMode, icon = 'message-square'): Mode => ({
  id: sessionMode.id,
  name: sessionMode.id,
  label: sessionMode.name,
  icon,
  ...acpModeDefaults,
})

/** Convert an ACP config option value to a Model object. */
export const modelFromConfigOption = (opt: { value: string; name: string; description?: string | null }): Model => ({
  id: opt.value,
  name: opt.name,
  model: opt.value,
  description: opt.description ?? null,
  ...acpModelDefaults,
})

/**
 * Extract the model select config option from ACP session config.
 * Returns the options array and current value, or null if not available.
 */
export const extractModelConfig = (
  configOptions: SessionConfigOption[],
): {
  options: Array<{ value: string; name: string; description?: string | null }>
  currentValue: string | null
} | null => {
  const modelConfig = configOptions.find((o) => o.category === 'model')
  if (!modelConfig || modelConfig.type !== 'select' || !Array.isArray(modelConfig.options)) {
    return null
  }
  const currentValue = 'currentValue' in modelConfig ? String(modelConfig.currentValue) : null
  return {
    options: modelConfig.options as Array<{ value: string; name: string; description?: string | null }>,
    currentValue,
  }
}

/**
 * Derive a Mode from ACP session state for the current mode.
 * Returns null if no modes are available.
 */
export const modeFromAcpSession = (sessionState: AgentSessionState): Mode | null => {
  const currentId = sessionState.currentModeId
  const acpMode = sessionState.availableModes.find((m) => m.id === currentId) ?? sessionState.availableModes[0]
  if (!acpMode) {
    return null
  }
  return modeFromSessionMode(acpMode, 'terminal')
}

/**
 * Derive a Model from ACP session state for the current model.
 * Returns null if no model config is available.
 */
export const modelFromAcpSession = (sessionState: AgentSessionState): Model | null => {
  const config = extractModelConfig(sessionState.configOptions)
  if (!config) {
    return null
  }
  const opt = config.options.find((o) => o.value === config.currentValue) ?? config.options[0]
  if (!opt) {
    return null
  }
  return modelFromConfigOption(opt)
}
