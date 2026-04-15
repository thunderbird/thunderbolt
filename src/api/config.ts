import { createClient, type HttpClient } from '@/lib/http'

export type AppConfig = Record<string, never>

export const fetchConfig = async (cloudUrl: string, httpClient?: HttpClient): Promise<AppConfig> => {
  try {
    const client = httpClient ?? createClient({ prefixUrl: cloudUrl })
    return await client.get('config').json<AppConfig>()
  } catch {
    console.warn('Failed to fetch app config, using defaults')
    return {}
  }
}
