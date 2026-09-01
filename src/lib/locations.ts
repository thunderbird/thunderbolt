/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'

/** Shape the backend's `/locations` routes return. */
type LocationResult = {
  id: number
  name: string
  region: string
  country: string
  countryCode: string
  lat: number
  lon: number
}

export type LocationData = {
  /**
   * Open-Meteo (GeoNames) id — the only language-independent handle on a place.
   * `name` localizes, so this is what gets persisted and re-resolved.
   */
  id: number
  /** Display string in the requested language: "Munique, Baviera, Alemanha". */
  name: string
  city: string
  /**
   * ISO 3166-1 alpha-2, or empty when the provider has none. Carried alongside
   * `name` because `name` ends in a display country that will localize, so it
   * cannot be reverse-matched to a region.
   */
  countryCode: string
  coordinates: {
    lat: number
    lng: number
  }
}

const toLocationData = (result: LocationResult): LocationData => ({
  id: result.id,
  name: [result.name, result.region, result.country].filter(Boolean).join(', '),
  city: result.name,
  countryCode: result.countryCode,
  coordinates: { lat: result.lat, lng: result.lon },
})

/**
 * Search places by name in the given language.
 *
 * @param httpClient - Authenticated backend client.
 * @param query - What the user typed.
 * @param language - BCP-47 tag; the backend narrows it to its base subtag.
 */
export const fetchLocations = async (
  httpClient: HttpClient,
  query: string,
  language: string,
): Promise<LocationData[]> => {
  const results = await httpClient.get('locations', { searchParams: { query, language } }).json<LocationResult[]>()
  return results.map(toLocationData)
}

/**
 * Re-resolve a known place in a given language. Used both to localize a stored
 * location for display and to recover its canonical English name for the model.
 *
 * @param httpClient - Authenticated backend client.
 * @param id - Open-Meteo place id.
 * @param language - BCP-47 tag; the backend narrows it to its base subtag.
 */
export const fetchLocationById = async (
  httpClient: HttpClient,
  id: number,
  language: string,
): Promise<LocationData> => {
  const result = await httpClient.get(`locations/${id}`, { searchParams: { language } }).json<LocationResult>()
  return toLocationData(result)
}
