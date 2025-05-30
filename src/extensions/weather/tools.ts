import { getDrizzleDatabase } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { WeatherClient } from '@agentic/weather'
import { eq } from 'drizzle-orm'
import ky from 'ky'
import { z } from 'zod'

// Cache for the ky instance to avoid recreating it
let cachedKyInstance: typeof ky | null = null
let cachedAnonymousId: string | null = null

const getOrCreateKyInstance = async () => {
  const { db } = await getDrizzleDatabase()

  const anonymousIdSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'anonymous_id')).get()
  const anonymousId = anonymousIdSetting?.value as string

  // Return cached instance if anonymous ID hasn't changed
  if (cachedKyInstance && cachedAnonymousId === anonymousId) {
    return cachedKyInstance
  }

  // Create new instance and cache it
  cachedKyInstance = ky.create({
    headers: {
      Authorization: `Bearer ${anonymousId}`,
    },
  })
  cachedAnonymousId = anonymousId

  return cachedKyInstance
}

// Cache for the weather client to avoid recreating it
let cachedWeatherClient: WeatherClient | null = null
let cachedCloudUrl: string | null = null

export const getOrCreateWeatherClient = async () => {
  const { db } = await getDrizzleDatabase()

  const cloudUrlSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url')).get()
  const cloudUrl = cloudUrlSetting?.value as string

  // Return cached client if cloud URL hasn't changed
  if (cachedWeatherClient && cachedCloudUrl === cloudUrl) {
    return cachedWeatherClient
  }

  // Create new client and cache it
  cachedWeatherClient = new WeatherClient({
    apiKey: 'none',
    apiBaseUrl: `${cloudUrl}/proxy/weather`,
    ky: await getOrCreateKyInstance(),
  })
  cachedCloudUrl = cloudUrl

  return cachedWeatherClient
}

export const getForecast = {
  name: 'weather.getForecast',
  description: 'Get the weather forecast.',
  verb: 'Checking the weather',
  parameters: z.object({
    // location: z.string().describe('The location to get the weather forecast for.').optional(),
  }),
  execute: async () => {
    const { db } = await getDrizzleDatabase()

    try {
      let url = 'https://api.open-meteo.com/v1/forecast?hourly=temperature_2m,precipitation,cloud_cover'

      // Get location from settings if available
      const locationLat = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat')).get()
      const locationLng = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng')).get()

      if (locationLat && locationLng) {
        url = `${url}&latitude=${locationLat}&longitude=${locationLng}`
      } else {
        // Fallback to default coordinates if no settings found
        url = `${url}&latitude=52.52&longitude=13.41`
      }

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Weather API returned ${response.status}: ${response.statusText}`)
      }

      console.log('response', response)

      const forecast = await response.json()

      console.log('forecast', forecast)
      return forecast
    } catch (error) {
      console.error('Error fetching weather forecast:', error)
      throw new Error('Failed to get weather forecast')
    }
  },
}
