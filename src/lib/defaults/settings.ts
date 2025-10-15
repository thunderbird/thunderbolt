import type { settingsTable } from '@/db/tables'
import type { InferSelectModel } from 'drizzle-orm'
import { hashValues } from '../utils'

export type Setting = InferSelectModel<typeof settingsTable>

/**
 * Compute hash of user-editable fields for a setting
 */
export const hashSetting = (setting: Setting): string => {
  return hashValues([setting.key, setting.value])
}

/**
 * Default settings shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 *
 * Note: Some settings are intentionally not included here because they're user-specific:
 * - anonymous_id: Generated uniquely per user
 * - selected_model: User's model selection
 * - preferred_name, location_*: User preferences
 * - integrations_*: User's integration credentials and settings
 */

export const defaultSettingDataCollection: Setting = {
  key: 'data_collection',
  value: 'true',
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingTriggersEnabled: Setting = {
  key: 'is_triggers_enabled',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingExperimentalFeatureTasks: Setting = {
  key: 'experimental_feature_tasks',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingNativeFetchEnabled: Setting = {
  key: 'is_native_fetch_enabled',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingDisableFlowerEncryption: Setting = {
  key: 'disable_flower_encryption',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingDebugPosthog: Setting = {
  key: 'debug_posthog',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingPreferredName: Setting = {
  key: 'preferred_name',
  value: null,
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingLocationName: Setting = {
  key: 'location_name',
  value: null,
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingLocationLat: Setting = {
  key: 'location_lat',
  value: null,
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingLocationLng: Setting = {
  key: 'location_lng',
  value: null,
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingCloudUrl: Setting = {
  key: 'cloud_url',
  value: null,
  updatedAt: null,
  defaultHash: null,
}

export const defaultSettingTheme: Setting = {
  key: 'ui-theme',
  value: 'system',
  updatedAt: null,
  defaultHash: null,
}

/**
 * Array of all default settings for iteration
 */
export const defaultSettings: ReadonlyArray<Setting> = [
  defaultSettingDataCollection,
  defaultSettingTriggersEnabled,
  defaultSettingExperimentalFeatureTasks,
  defaultSettingNativeFetchEnabled,
  defaultSettingDisableFlowerEncryption,
  defaultSettingDebugPosthog,
  defaultSettingPreferredName,
  defaultSettingLocationName,
  defaultSettingLocationLat,
  defaultSettingLocationLng,
  defaultSettingCloudUrl,
  defaultSettingTheme,
] as const
