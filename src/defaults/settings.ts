/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

/**
 * Default settings shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 *
 * Settings the user owns (`preferred_name`, `location_*`, the unit settings,
 * `language`) ship with a **null** value rather than being left out. That null
 * is load-bearing: it is what lets reconcile's `wouldOverwriteUserValue` guard
 * recognize a seeded or user-set value and preserve it across a
 * `defaultSettingsVersion` bump. A setting genuinely absent from this array is
 * unmanaged instead — `anonymous_id` and `selected_model`, which are generated
 * per device and per user.
 */

export const defaultSettingDataCollection: Setting = {
  key: 'data_collection',
  value: 'false',
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

export const defaultSettingExperimentalFeatureVoice: Setting = {
  key: 'experimental_feature_voice',
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

/**
 * ISO 3166-1 alpha-2, written from the geocoding provider's own `country_code`
 * rather than parsed back out of `location_name`. The display name localizes;
 * the code does not.
 */
export const defaultSettingLocationCountryCode: Setting = {
  key: 'location_country_code',
  value: null,
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

/**
 * UI language as a BCP-47 tag. Ships as null (rendered as 'en' via the
 * `useSettings` schema fallback); while unmodified it is seeded from
 * `navigator.languages` on boot (see `useAppLanguage`), so an explicit user
 * choice is the only thing that pins it. The null default matters: reconcile's
 * `wouldOverwriteUserValue` guard only protects seeded values across
 * `defaultSettingsVersion` bumps when the shipped default is null — the same
 * mechanic as the country-derived unit defaults.
 */
export const defaultSettingLanguage: Setting = {
  key: 'language',
  value: null,
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
  defaultSettingExperimentalFeatureVoice,
  defaultSettingPreferredName,
  defaultSettingLocationName,
  defaultSettingLocationLat,
  defaultSettingLocationLng,
  defaultSettingLocationCountryCode,
  defaultSettingDistanceUnit,
  defaultSettingTemperatureUnit,
  defaultSettingTimeFormat,
  defaultSettingCurrency,
  defaultSettingIntegrationsProIsEnabled,
  defaultSettingUserHasCompletedOnboarding,
  defaultSettingContentViewWidth,
  defaultSettingIntegrationsDoNotAskAgain,
  defaultSettingLanguage,
] as const

/**
 * Monotonic version of the shipped setting defaults. Bump every time
 * `defaultSettings` changes in any way. Reconcile uses this as the ordering
 * signal so multi-device sync groups converge without ping-ponging (THU-637
 * pattern extended to settings in THU-677): a device only overwrites existing
 * rows when this bundled version is strictly newer than the highest ever
 * applied on this account.
 *
 * The paired snapshot test in `settings.test.ts` fails on any change to this
 * file's defaults without a matching version bump.
 */
export const defaultSettingsVersion = 4
