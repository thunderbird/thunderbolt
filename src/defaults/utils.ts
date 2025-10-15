import type { modelsTable, promptsTable, settingsTable } from '@/db/tables'
import type { InferSelectModel } from 'drizzle-orm'
import { hashPrompt } from './automations'
import { hashModel } from './models'
import { hashSetting } from './settings'

type Model = InferSelectModel<typeof modelsTable>
type Prompt = InferSelectModel<typeof promptsTable>
type Setting = InferSelectModel<typeof settingsTable>

/**
 * Check if a model has been modified from its default
 */
export const isModelModified = (model: Model): boolean => {
  if (!model.defaultHash) return false
  const currentHash = hashModel(model)
  return currentHash !== model.defaultHash
}

/**
 * Check if an automation has been modified from its default
 */
export const isAutomationModified = (prompt: Prompt): boolean => {
  if (!prompt.defaultHash) return false
  const currentHash = hashPrompt(prompt)
  return currentHash !== prompt.defaultHash
}

/**
 * Check if a setting has been modified from its default
 */
export const isSettingModified = (setting: Setting | undefined): boolean => {
  if (!setting || !setting.defaultHash) return false
  const currentHash = hashSetting(setting)
  return currentHash !== setting.defaultHash
}
