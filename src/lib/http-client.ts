import { getSettings } from '@/dal'
import ky from 'ky'

// Cache for the HTTP client as a singleton instance to avoid recreating it
let singleton: typeof ky | null = null

// Function to get or create a singleton (cached) ky instance with the correct baseURL
export const getHttpClient = async (): Promise<typeof ky> => {
  if (singleton) {
    return singleton
  }

  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })

  singleton = ky.create({
    prefixUrl: cloudUrl,
  })

  return singleton
}
