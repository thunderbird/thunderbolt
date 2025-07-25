import { getBooleanSetting } from '@/lib/dal'
import { isTauri } from '@/lib/platform'

/**
 * Custom fetch function that handles CORS issues by routing through Tauri when available
 * @param input - The resource to fetch
 * @param init - Optional request configuration
 * @returns Promise that resolves to the Response
 */
export const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isTauri()) {
    return globalThis.fetch(input, init)
  }

  const tauriFetchEnabled = await getBooleanSetting('is_native_fetch_enabled', false)

  if (tauriFetchEnabled) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    return tauriFetch(input, init)
  }

  return globalThis.fetch(input, init)
}

// Bun's `fetch` type expects a `preconnect` method.
fetch.preconnect = () => Promise.resolve(false)
