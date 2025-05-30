import { getDrizzleDatabase } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import ky from 'ky'

// Default baseURL in case we can't get it from the database
const DEFAULT_BASE_URL = 'http://localhost:8000'

// Cache for the HTTP client as a singleton instance to avoid recreating it
let singleton: typeof ky | null = null

// Function to get server URL from database
export const getServerUrl = async (): Promise<string> => {
  try {
    const { db } = await getDrizzleDatabase()
    const serverUrlSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'server_url')).get()

    return (serverUrlSetting?.value as string) || DEFAULT_BASE_URL
  } catch (error) {
    console.error('Error getting server URL from database:', error)
    return DEFAULT_BASE_URL
  }
}

// Function to get or create a singleton (cached) ky instance with the correct baseURL
export const getHttpClient = async (): Promise<typeof ky> => {
  if (singleton) {
    return singleton
  }

  const serverUrl = await getServerUrl()

  singleton = ky.create({
    prefixUrl: serverUrl,
  })

  return singleton
}
