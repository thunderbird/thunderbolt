import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'

/**
 * Get the default cloud URL from environment variables or fallback to localhost
 */
export const getDefaultCloudUrl = (): string => {
  return import.meta.env?.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000'
}

/**
 * Get the cloud URL from settings or fallback to default
 */
export const getCloudUrl = async (): Promise<string> => {
  const db = DatabaseSingleton.instance.db
  const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url')).get()
  return (setting?.value as string) || getDefaultCloudUrl()
}
