/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { http, type HttpClient } from '@/lib/http'
import { WeatherForecastDataSchema, type WeatherDay, type WeatherForecastData } from './lib'

export type FetchWeatherForecastParams = {
  location: string
  region: string
  country: string
  days: number
  temperatureUnit: 'c' | 'f'
}

type GeoLocation = {
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
const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
const requestTimeout = 10000
const dailyFields = 'weather_code,temperature_2m_max'

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
  const { location, region, country, days, temperatureUnit } = params

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

  const forecast = await httpClient
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
    .json<ForecastResponse>()

  const { daily } = forecast
  const count = Math.min(daily.time.length, days)
  const weatherDays: WeatherDay[] = Array.from({ length: count }, (_, i) => ({
    date: daily.time[i],
    weather_code: daily.weather_code[i] ?? 0,
    temperature_max: daily.temperature_2m_max[i],
  }))

  const locationName = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ')

  // Validation boundary for untrusted OpenMeteo data: `.min(1)` turns an empty/short forecast into a
  // thrown error instead of a perpetual skeleton.
  return WeatherForecastDataSchema.parse({
    location: locationName,
    days: weatherDays,
    temperature_unit: temperatureUnit,
  })
}
