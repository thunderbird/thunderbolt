/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WeatherDay, WeatherForecastData } from './types'

type LocalizationParams = {
  temperatureUnit?: 'celsius' | 'fahrenheit'
  windSpeedUnit?: 'kmh' | 'ms' | 'mph' | 'kn'
  precipitationUnit?: 'mm' | 'inch'
  timeFormat?: 'iso8601' | 'unixtime'
  language?: string
}

/**
 * Weather-specific user preferences for Open-Meteo API localization
 * Only includes the properties that are actually used by the weather client.
 * This is a subset of the full PreferencesSettings type from the frontend.
 */
type WeatherPreferences = {
  distanceUnit?: 'metric' | 'imperial'
  temperatureUnit?: 'c' | 'f'
}

interface Location {
  name: string
  admin1?: string
  country?: string
  latitude: number
  longitude: number
  elevation?: number
}

/**
 * OpenMeteo weather client
 */
export class OpenMeteoWeather {
  private readonly geocodingUrl = 'https://geocoding-api.open-meteo.com/v1/search'
  private readonly weatherUrl = 'https://api.open-meteo.com/v1/forecast'
  private readonly fetchFn: typeof fetch

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.fetchFn = fetchFn
  }

  /**
   * Convert user preferences to Open-Meteo API parameters
   */
  private getUserLocalizationParams(userPreferences?: WeatherPreferences): LocalizationParams {
    const temperatureUnit = userPreferences?.temperatureUnit === 'f' ? 'fahrenheit' : 'celsius'

    if (userPreferences?.distanceUnit === 'imperial') {
      return {
        temperatureUnit,
        windSpeedUnit: 'mph',
        precipitationUnit: 'inch',
        timeFormat: 'iso8601',
      }
    }

    return {
      temperatureUnit,
      windSpeedUnit: 'kmh',
      precipitationUnit: 'mm',
      timeFormat: 'iso8601',
    }
  }

  /**
   * Apply localization parameters to URL
   */
  private applyLocalizationParams(url: URL, params: LocalizationParams): void {
    if (params.temperatureUnit) {
      url.searchParams.set('temperature_unit', params.temperatureUnit)
    }
    if (params.windSpeedUnit) {
      url.searchParams.set('wind_speed_unit', params.windSpeedUnit)
    }
    if (params.precipitationUnit) {
      url.searchParams.set('precipitation_unit', params.precipitationUnit)
    }
    if (params.timeFormat) {
      url.searchParams.set('timeformat', params.timeFormat)
    }
  }

  private disambiguateLocation(locations: Location[], region: string | null, country: string | null): Location[] {
    const regionNorm = region?.trim().toLowerCase()
    const countryNorm = country?.trim().toLowerCase()

    let matches = [...locations]

    // If region is provided, try to match admin1 (state/region)
    if (regionNorm) {
      const regionMatches = matches.filter((r) => r.admin1?.toLowerCase().includes(regionNorm))
      if (regionMatches.length > 0) {
        matches = regionMatches
      }
    }

    // If country is provided, match against country field
    if (countryNorm) {
      const countryMatches = matches.filter((r) => r.country?.toLowerCase().includes(countryNorm))
      if (countryMatches.length > 0) {
        matches = countryMatches
      }
    }

    return matches
  }

  /**
   * Search for locations by name
   */
  async searchLocations(query: string, region: string | null, country: string | null): Promise<Location[]> {
    const url = new URL(this.geocodingUrl)
    url.searchParams.set('name', query)
    url.searchParams.set('count', '10')
    url.searchParams.set('language', 'en')
    url.searchParams.set('format', 'json')

    const response = await this.fetchFn(url.toString())

    if (!response.ok) {
      throw new Error(`Geocoding API error: ${response.status}`)
    }

    const data = (await response.json()) as { results?: Location[] }
    const locations = data.results || []

    return this.disambiguateLocation(locations, region, country)
  }

  /**
   * Get current weather for a location
   */
  async getCurrentWeather(
    location: string,
    region: string | null,
    country: string | null,
    userPreferences?: WeatherPreferences,
  ): Promise<string> {
    // First, search for the location
    const locations = await this.searchLocations(location, region, country)
    if (locations.length === 0) {
      return `No location found matching: ${location}`
    }

    const loc = locations[0]

    // Get current weather
    const url = new URL(this.weatherUrl)
    url.searchParams.set('latitude', loc.latitude.toString())
    url.searchParams.set('longitude', loc.longitude.toString())
    url.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    )
    url.searchParams.set('timezone', 'auto')

    // Apply user localization preferences
    const localizationParams = this.getUserLocalizationParams(userPreferences)
    this.applyLocalizationParams(url, localizationParams)

    const response = await this.fetchFn(url.toString())

    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`)
    }

    const data = (await response.json()) as {
      current: {
        temperature_2m: number
        relative_humidity_2m: number
        apparent_temperature: number
        weather_code: number
        wind_speed_10m: number
        wind_direction_10m: number
        time: string
      }
      current_units: Record<string, string>
    }

    const current = data.current
    const units = data.current_units

    // Format the weather data
    const locationStr = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ')

    const result = [
      `Current weather for ${locationStr}:`,
      `Temperature: ${current.temperature_2m}${units.temperature_2m}`,
      `Feels like: ${current.apparent_temperature}${units.apparent_temperature}`,
      `Humidity: ${current.relative_humidity_2m}${units.relative_humidity_2m}`,
      `Wind: ${current.wind_speed_10m}${units.wind_speed_10m} at ${current.wind_direction_10m}°`,
      `Conditions: ${this.getWeatherDescription(current.weather_code)} (Code ${current.weather_code})`,
      `Last updated: ${current.time}`,
    ]

    return result.join('\n')
  }

  /**
   * Get weather forecast for a location
   */
  async getWeatherForecast(
    location: string,
    region: string | null,
    country: string | null,
    days: number,
    userPreferences?: WeatherPreferences,
  ): Promise<WeatherForecastData> {
    try {
      // First, search for the location
      const locations = await this.searchLocations(location, region, country)
      if (locations.length === 0) {
        const errorMsg = `Could not find coordinates for location '${location}'`
        throw new Error(errorMsg)
      }

      const loc = locations[0]

      // Get weather forecast
      const url = new URL(this.weatherUrl)
      url.searchParams.set('latitude', loc.latitude.toString())
      url.searchParams.set('longitude', loc.longitude.toString())
      url.searchParams.set(
        'daily',
        'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max',
      )
      url.searchParams.set('forecast_days', days.toString())
      url.searchParams.set('timezone', 'auto')

      // Apply user localization preferences
      const localizationParams = this.getUserLocalizationParams(userPreferences)
      this.applyLocalizationParams(url, localizationParams)

      // Determine temperature unit based on what was requested
      const temperatureUnit: 'c' | 'f' = localizationParams.temperatureUnit === 'fahrenheit' ? 'f' : 'c'

      const response = await this.fetchFn(url.toString())

      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`)
      }

      const data = (await response.json()) as {
        daily: {
          time: string[]
          weather_code: number[]
          temperature_2m_max: number[]
          temperature_2m_min: number[]
          apparent_temperature_max: number[]
          apparent_temperature_min: number[]
          precipitation_sum: number[]
          precipitation_probability_max: number[]
          wind_speed_10m_max: number[]
        }
        daily_units: Record<string, string>
      }

      const daily = data.daily

      // Build location string with admin and country info
      const locationParts = [loc.name]
      if (loc.admin1) {
        locationParts.push(loc.admin1)
      }
      if (loc.country) {
        locationParts.push(loc.country)
      }
      const fullLocationName = locationParts.join(', ')

      // Create structured weather days
      const weatherDays: WeatherDay[] = []
      for (let i = 0; i < Math.min(daily.time.length, days); i++) {
        const weatherCode = daily.weather_code[i] ?? 0

        const weatherDay: WeatherDay = {
          date: daily.time[i],
          weather_code: weatherCode,
          temperature_max: daily.temperature_2m_max[i],
          temperature_min: daily.temperature_2m_min[i],
          apparent_temperature_max: daily.apparent_temperature_max[i],
          apparent_temperature_min: daily.apparent_temperature_min[i],
          precipitation_sum: daily.precipitation_sum[i],
          precipitation_probability_max: daily.precipitation_probability_max[i],
          wind_speed_10m_max: daily.wind_speed_10m_max[i],
        }
        weatherDays.push(weatherDay)
      }

      return {
        location: fullLocationName,
        days: weatherDays,
        temperature_unit: temperatureUnit,
      }
    } catch (error) {
      throw new Error(`Could not fetch forecast data: ${String(error)}`)
    }
  }

  /**
   * Convert WMO weather code to description
   */
  private getWeatherDescription(code: number): string {
    const weatherCodes: Record<number, string> = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      56: 'Light freezing drizzle',
      57: 'Dense freezing drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      66: 'Light freezing rain',
      67: 'Heavy freezing rain',
      71: 'Slight snow fall',
      73: 'Moderate snow fall',
      75: 'Heavy snow fall',
      77: 'Snow grains',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      85: 'Slight snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail',
    }
    return weatherCodes[code] || `Unknown (code ${code})`
  }
}
