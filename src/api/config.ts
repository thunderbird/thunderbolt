import { createClient, type HttpClient } from '@/lib/http'
import type { AppConfig } from './config-store'

export const fetchConfig = async (cloudUrl: string, httpClient?: HttpClient): Promise<AppConfig | null> => {
  try {
    const client = httpClient ?? createClient({ prefixUrl: cloudUrl })
    return await client.get('config').json<AppConfig>()
  } catch {
    console.warn('Failed to fetch app config, using cached value')
    return null
  }
}
