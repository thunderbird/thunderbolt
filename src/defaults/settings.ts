import { isOidcMode } from '@/lib/auth-mode'
import type { settingsTable } from '@/db/tables'
import { hashValues } from '@/lib/utils'
import type { InferSelectModel } from 'drizzle-orm'

export type Setting = InferSelectModel<typeof settingsTable>

/**
 * Data collection default:
 * - consumer mode: enabled by default
 * - oidc mode (self-hosted/enterprise): disabled by default
 */
export const getDefaultDataCollectionValue = (): boolean => !isOidcMode()

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
  value: String(getDefaultDataCollectionValue()),
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingTriggersEnabled: Setting = {
  key: 'is_triggers_enabled',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingExperimentalFeatureTasks: Setting = {
  key: 'experimental_feature_tasks',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingNativeFetchEnabled: Setting = {
  key: 'is_native_fetch_enabled',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingDebugPosthog: Setting = {
  key: 'debug_posthog',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingPreferredName: Setting = {
  key: 'preferred_name',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingLocationName: Setting = {
  key: 'location_name',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingLocationLat: Setting = {
  key: 'location_lat',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingLocationLng: Setting = {
  key: 'location_lng',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingCloudUrl: Setting = {
  key: 'cloud_url',
  value: import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingTheme: Setting = {
  key: 'ui-theme',
  value: 'system',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingDistanceUnit: Setting = {
  key: 'distance_unit',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingTemperatureUnit: Setting = {
  key: 'temperature_unit',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingDateFormat: Setting = {
  key: 'date_format',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingTimeFormat: Setting = {
  key: 'time_format',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingCurrency: Setting = {
  key: 'currency',
  value: null,
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingIntegrationsProIsEnabled: Setting = {
  key: 'integrations_pro_is_enabled',
  value: 'true',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingContentViewWidth: Setting = {
  key: 'content_view_width',
  value: '50',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingUserHasCompletedOnboarding: Setting = {
  key: 'user_has_completed_onboarding',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingIntegrationsDoNotAskAgain: Setting = {
  key: 'integrations_do_not_ask_again',
  value: 'false',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultSettingHapticsEnabled: Setting = {
  key: 'haptics_enabled',
  value: 'true',
  updatedAt: null,
  defaultHash: null,
  userId: null,
}

/**
 * Array of all default settings for iteration
 */
export const defaultSettings: ReadonlyArray<Setting> = [
  defaultSettingDataCollection,
  defaultSettingTriggersEnabled,
  defaultSettingExperimentalFeatureTasks,
  defaultSettingNativeFetchEnabled,
  defaultSettingDebugPosthog,
  defaultSettingPreferredName,
  defaultSettingLocationName,
  defaultSettingLocationLat,
  defaultSettingLocationLng,
  defaultSettingCloudUrl,
  defaultSettingTheme,
  defaultSettingDistanceUnit,
  defaultSettingTemperatureUnit,
  defaultSettingDateFormat,
  defaultSettingTimeFormat,
  defaultSettingCurrency,
  defaultSettingIntegrationsProIsEnabled,
  defaultSettingUserHasCompletedOnboarding,
  defaultSettingContentViewWidth,
  defaultSettingIntegrationsDoNotAskAgain,
  defaultSettingHapticsEnabled,
] as const
