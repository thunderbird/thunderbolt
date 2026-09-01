/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { fetchLocationById } from '@/lib/locations'
import { baseLanguage } from '@shared/i18n/base-language'
import { useQuery } from '@tanstack/react-query'

/**
 * The user's saved location, rendered in the active language.
 *
 * The stored `location_name` is English on purpose — it is model-facing — so
 * the display name is derived from `location_id` rather than stored alongside
 * it. That keeps it following a language change instead of freezing at whatever
 * language the place was picked in. The stored name shows through while the
 * lookup is in flight, when it fails, and for rows saved before `location_id`
 * existed; English callers never fetch at all.
 *
 * @param locationId - Stored `location_id`; empty when unset or pre-THU-847.
 * @param locationName - Stored `location_name`, the English fallback.
 * @returns The location as a display string, or an empty string when unset.
 */
export const useLocalizedLocationName = (locationId: string, locationName: string): string => {
  const httpClient = useHttpClient()
  const locale = useActiveLocale()
  const id = Number(locationId)
  const language = baseLanguage(locale)

  const { data } = useQuery({
    queryKey: ['location', id, language],
    queryFn: () => fetchLocationById(httpClient, id, locale),
    enabled: id > 0 && language !== 'en',
    // A place's name in a given language does not change.
    staleTime: Infinity,
  })

  return data?.name ?? locationName
}
