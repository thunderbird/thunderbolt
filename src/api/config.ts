import { createClient, type HttpClient } from '@/lib/http'
import type { AppConfig } from './config-store'

/**
 * Fetches the public app config from the backend.
 * Returns `null` on failure so the caller can preserve the cached localStorage value.
 * @param httpClient - Optional pre-configured client; when omitted, creates an unauthenticated client with `cloudUrl`.
 */
export const fetchConfig = async (cloudUrl: string, httpClient?: HttpClient): Promise<AppConfig | null> => {
  try {
    const client = httpClient ?? createClient({ prefixUrl: cloudUrl })
    return await client.get('config', { timeout: 5_000 }).json<AppConfig>()
  } catch {
    console.warn('Failed to fetch app config, using cached value')
    return null
  }
}
