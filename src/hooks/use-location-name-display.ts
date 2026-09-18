/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { fetchLocationById } from '@/lib/locations'
import type { StringSettingWithDefaultHook } from '@/hooks/use-settings'
import { baseLanguage } from '@shared/i18n/base-language'
import { useEffect, useEffectEvent } from 'react'

/**
 * The user's saved location, rendered in the active language.
 *
 * Reads the stored `location_name_display` rather than resolving on every
 * render: only the geocoding provider knows city and region names, so a lookup
 * per render would make a settings page need the network and flash the English
 * name on the way. The stored value covers the offline and standalone cases.
 *
 * The lookup here is the refill path, not the normal one — picking a place
 * writes the display name for free, so this only fires for a language change
 * (`useLanguageSetting` clears the row) and for locations saved before the
 * setting existed. Failing it is not worth surfacing: `location_name` shows
 * through in English and the next mount tries again.
 *
 * @param locationId - Stored `location_id`; empty when unset or pre-THU-847.
 * @param locationName - Stored `location_name`, the English fallback.
 * @param display - The `location_name_display` setting, read and refilled here.
 * @returns The location as a display string, or an empty string when unset.
 */
export const useLocationNameDisplay = (
  locationId: string,
  locationName: string,
  display: StringSettingWithDefaultHook,
): string => {
  const httpClient = useHttpClient()
  const locale = useActiveLocale()
  const id = Number(locationId)

  // `isLoading` is part of the condition, not an optimization: the stored value
  // reads as empty until the query settles, and resolving off that would fetch
  // on every mount — the thing this setting exists to avoid.
  const needsResolve = id > 0 && baseLanguage(locale) !== 'en' && !display.isLoading && !display.value

  const resolve = useEffectEvent(async () => {
    try {
      const { name } = await fetchLocationById(httpClient, id, locale)
      // Machine-derived rather than user intent, so it stays a seeded value:
      // it must not read as modified in the UI, and reconcile must leave it be.
      await display.setValue(name, { recomputeHash: true })
    } catch (error) {
      console.error('Failed to resolve the localized location name:', error)
    }
  })

  useEffect(() => {
    if (needsResolve) {
      void resolve()
    }
  }, [needsResolve])

  return display.value || locationName
}
