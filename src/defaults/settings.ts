import type { settingsTable } from '@/db/tables'
import { hashValues } from '@/lib/utils'
import type { InferSelectModel } from 'drizzle-orm'

export type Setting = InferSelectModel<typeof settingsTable>

/**
 * Compute hash of user-editable fields for a setting
 */
export const hashSetting = (setting: Setting): string => {
  return hashValues([setting.key, setting.value])
}

const defaultBackendPort = import.meta.env.VITE_THUNDERBOLT_BACKEND_PORT?.trim() || '8000'
const fallbackCloudUrl = `http://localhost:${defaultBackendPort}/v1`

const normalizeHostname = (hostname: string): string => hostname.replace(/^\[|\]$/g, '').toLowerCase()

const isLoopbackHostname = (hostname: string): boolean => {
  const normalizedHostname = normalizeHostname(hostname)
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '0.0.0.0' ||
    normalizedHostname === '::1'
  )
}

const isLoopbackUrl = (url: string): boolean => {
  try {
    return isLoopbackHostname(new URL(url).hostname)
  } catch {
    return false
  }
}

const deriveCloudUrlFromWindowLocation = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }

  if (!['http:', 'https:'].includes(window.location.protocol)) {
    return null
  }

  const url = new URL(window.location.origin)
  url.port = defaultBackendPort
  url.pathname = '/v1'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

/**
 * Resolve the default backend URL for the current runtime.
 * When the frontend is opened from a LAN or Tailscale hostname, a loopback-configured
 * cloud URL is treated as a local placeholder and rewritten to the current hostname.
 */
export const getDefaultCloudUrl = (): string => {
  const configuredCloudUrl = import.meta.env.VITE_THUNDERBOLT_CLOUD_URL?.trim()
  const derivedCloudUrl = deriveCloudUrlFromWindowLocation()

  if (!configuredCloudUrl) {
    return derivedCloudUrl ?? fallbackCloudUrl
  }

  if (derivedCloudUrl && isLoopbackUrl(configuredCloudUrl) && !isLoopbackHostname(window.location.hostname)) {
    return derivedCloudUrl
  }

  return configuredCloudUrl
}

export const defaultCloudUrlValue = getDefaultCloudUrl()

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
  value: defaultCloudUrlValue,
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
