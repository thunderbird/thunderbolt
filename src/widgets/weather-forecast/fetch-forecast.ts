/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { http, type HttpClient } from '@/lib/http'
import { baseLanguage } from '@shared/i18n/base-language'
import { WeatherForecastDataSchema, type WeatherDay, type WeatherForecastData } from './lib'

export type FetchWeatherForecastParams = {
  location: string
  region: string
  country: string
  days: number
  temperatureUnit: 'c' | 'f'
  /** BCP-47 tag the resolved place name is displayed in. */
  locale: string
}

type GeoLocation = {
  id: number
  name: string
  admin1?: string
  country?: string
  latitude: number
  longitude: number
}

type GeocodingResponse = {
  results?: GeoLocation[]
}

type ForecastResponse = {
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
  }
}

const geocodingUrl = 'https://geocoding-api.open-meteo.com/v1/search'
const geocodingByIdUrl = 'https://geocoding-api.open-meteo.com/v1/get'
const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
const requestTimeout = 10000
const dailyFields = 'weather_code,temperature_2m_max'

const formatPlaceName = (place: GeoLocation): string =>
  [place.name, place.admin1, place.country].filter(Boolean).join(', ')

/**
 * Re-resolve an already-disambiguated place by id to get its name in `locale`.
 *
 * Identity is settled by then, so this only ever touches what is displayed —
 * which is why a failure falls back to the English name rather than surfacing.
 * A missing city name is not worth replacing a working forecast with an error.
 */
const fetchLocalizedPlaceName = async (place: GeoLocation, locale: string, httpClient: HttpClient): Promise<string> => {
  const language = baseLanguage(locale)
  if (language === 'en') {
    return formatPlaceName(place)
  }

  try {
    const localized = await httpClient
      .get(geocodingByIdUrl, { timeout: requestTimeout, searchParams: { id: place.id, language } })
      .json<GeoLocation>()
    return formatPlaceName(localized)
  } catch {
    return formatPlaceName(place)
  }
}

/**
 * Narrow a candidate list with a predicate, keeping the original list when nothing matches.
 * Mirrors the backend's permissive disambiguation: a too-specific filter never strands the user
 * with zero results.
 */
const narrowMatches = <T>(candidates: T[], predicate: (item: T) => boolean): T[] => {
  const matches = candidates.filter(predicate)
  return matches.length > 0 ? matches : candidates
}

/**
 * Disambiguate geocoding results by region (admin1) then country, falling back to the broader set
 * when a filter would otherwise eliminate every candidate.
 */
const disambiguateLocation = (locations: GeoLocation[], region: string, country: string): GeoLocation[] => {
  const regionNorm = region.trim().toLowerCase()
  const countryNorm = country.trim().toLowerCase()

  const byRegion = regionNorm
    ? narrowMatches(locations, (loc) => loc.admin1?.toLowerCase().includes(regionNorm) ?? false)
    : locations

  return countryNorm
    ? narrowMatches(byRegion, (loc) => loc.country?.toLowerCase().includes(countryNorm) ?? false)
    : byRegion
}

/**
 * Fetch a daily weather forecast directly from OpenMeteo (keyless, CORS-enabled), spreading requests
 * across user IPs instead of the backend's shared IP. Geocodes the location, disambiguates by
 * region/country, then returns the structured forecast the widget renders.
 *
 * @param params - Location, region, country, day count, and temperature unit.
 * @param httpClient - HTTP client; defaults to the no-auth external `http` client. Injectable for tests.
 */
export const fetchWeatherForecast = async (
  params: FetchWeatherForecastParams,
  httpClient: HttpClient = http,
): Promise<WeatherForecastData> => {
  const { location, region, country, days, temperatureUnit, locale } = params

  // Deliberately English, not the active locale, and it must stay that way.
  // Open-Meteo localizes the `name`, `admin1` and `country` it returns, and
  // `disambiguateLocation` matches `region`/`country` against them — but those
  // two come from the model's widget arguments, whose language we cannot know
  // (the instructions prompt English examples, so they are usually English
  // whatever the UI language is). Asking in French would return `États-Unis`
  // for a model-supplied `United States`, match nothing, and let `narrowMatches`
  // fall back to every candidate — silently returning Paris, France for Paris,
  // Texas. The displayed name is localized further down instead, once `id` has
  // settled which place this is.
  const geocoding = await httpClient
    .get(geocodingUrl, {
      timeout: requestTimeout,
      searchParams: { name: location, count: 10, language: 'en', format: 'json' },
    })
    .json<GeocodingResponse>()

  const matches = disambiguateLocation(geocoding.results ?? [], region, country)
  if (matches.length === 0) {
    throw new Error(`Could not find coordinates for location '${location}'`)
  }

  const loc = matches[0]

  // Both only need the geocoded winner, so the display name costs no wall clock.
  const [forecast, locationName] = await Promise.all([
    httpClient
      .get(forecastUrl, {
        timeout: requestTimeout,
        searchParams: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          daily: dailyFields,
          forecast_days: days,
          timezone: 'auto',
          temperature_unit: temperatureUnit === 'f' ? 'fahrenheit' : 'celsius',
        },
      })
      .json<ForecastResponse>(),
    fetchLocalizedPlaceName(loc, locale, httpClient),
  ])

  const { daily } = forecast
  const count = Math.min(daily.time.length, days)
  const weatherDays: WeatherDay[] = Array.from({ length: count }, (_, i) => ({
    date: daily.time[i],
    weather_code: daily.weather_code[i] ?? 0,
    temperature_max: daily.temperature_2m_max[i],
  }))

  // Validation boundary for untrusted OpenMeteo data: `.min(1)` turns an empty/short forecast into a
  // thrown error instead of a perpetual skeleton.
  return WeatherForecastDataSchema.parse({
    location: locationName,
    days: weatherDays,
    temperature_unit: temperatureUnit,
  })
}
