import type { SimpleContext } from './context'

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

  /**
   * Search for locations by name
   */
  async searchLocations(query: string, ctx: SimpleContext): Promise<Location[]> {
    try {
      await ctx.info(`Searching locations for: ${query}`)

      const url = new URL(this.geocodingUrl)
      url.searchParams.set('name', query)
      url.searchParams.set('count', '10')
      url.searchParams.set('language', 'en')
      url.searchParams.set('format', 'json')

      const response = await fetch(url.toString())

      if (!response.ok) {
        throw new Error(`Geocoding API error: ${response.status}`)
      }

      const data = (await response.json()) as { results?: Location[] }
      const locations = data.results || []

      await ctx.info(`Found ${locations.length} locations`)
      return locations
    } catch (error) {
      await ctx.error(`Location search error: ${String(error)}`)
      throw error
    }
  }

  /**
   * Get current weather for a location
   */
  async getCurrentWeather(location: string, ctx: SimpleContext): Promise<string> {
    try {
      await ctx.info(`Getting current weather for: ${location}`)

      // First, search for the location
      const locations = await this.searchLocations(location, ctx)
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

      const response = await fetch(url.toString())

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
        `Weather code: ${current.weather_code}`,
        `Last updated: ${current.time}`,
      ]

      return result.join('\n')
    } catch (error) {
      await ctx.error(`Weather fetch error: ${String(error)}`)
      throw error
    }
  }

  /**
   * Get weather forecast for a location
   */
  async getWeatherForecast(location: string, days: number, ctx: SimpleContext): Promise<string> {
    try {
      await ctx.info(`Getting ${days}-day forecast for: ${location}`)

      // First, search for the location
      const locations = await this.searchLocations(location, ctx)
      if (locations.length === 0) {
        return `No location found matching: ${location}`
      }

      const loc = locations[0]

      // Get weather forecast
      const url = new URL(this.weatherUrl)
      url.searchParams.set('latitude', loc.latitude.toString())
      url.searchParams.set('longitude', loc.longitude.toString())
      url.searchParams.set(
        'daily',
        'temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,wind_speed_10m_max',
      )
      url.searchParams.set('forecast_days', days.toString())
      url.searchParams.set('timezone', 'auto')

      const response = await fetch(url.toString())

      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`)
      }

      const data = (await response.json()) as {
        daily: {
          time: string[]
          temperature_2m_max: number[]
          temperature_2m_min: number[]
          weather_code: number[]
          precipitation_sum: number[]
          wind_speed_10m_max: number[]
        }
        daily_units: Record<string, string>
      }

      const daily = data.daily
      const units = data.daily_units

      // Format the forecast data
      const locationStr = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ')

      const result = [`${days}-day weather forecast for ${locationStr}:`, '']

      for (let i = 0; i < daily.time.length; i++) {
        const date = new Date(daily.time[i]).toLocaleDateString()
        result.push(`${date}:`)
        result.push(`  High: ${daily.temperature_2m_max[i]}${units.temperature_2m_max}`)
        result.push(`  Low: ${daily.temperature_2m_min[i]}${units.temperature_2m_min}`)
        result.push(`  Precipitation: ${daily.precipitation_sum[i]}${units.precipitation_sum}`)
        result.push(`  Max wind: ${daily.wind_speed_10m_max[i]}${units.wind_speed_10m_max}`)
        result.push(`  Weather code: ${daily.weather_code[i]}`)
        result.push('')
      }

      return result.join('\n').trim()
    } catch (error) {
      await ctx.error(`Weather forecast error: ${String(error)}`)
      throw error
    }
  }
}
