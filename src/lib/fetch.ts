import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
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

  const db = getDb()
  const { isNativeFetchEnabled } = await getSettings(db, { is_native_fetch_enabled: false })

  if (isNativeFetchEnabled) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    return tauriFetch(input, init)
  }

  return globalThis.fetch(input, init)
}

// Bun's `fetch` type expects a `preconnect` method.
fetch.preconnect = () => Promise.resolve(false)

/**
 * Always-native fetch — routes through Tauri's HTTP plugin when running inside Tauri,
 * regardless of the user-facing `is_native_fetch_enabled` toggle.
 *
 * Use this for direct calls to third-party AI providers (OpenAI/Anthropic/OpenRouter/etc.).
 * The Tauri WebView strips the `Authorization` header from cross-origin POSTs that carry
 * `Content-Type: application/json` + a `User-Agent` suffix (the AI SDK adds both), so those
 * requests must go through the native HTTP plugin to reach the provider with credentials intact.
 */
export const nativeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isTauri()) {
    return globalThis.fetch(input, init)
  }
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  return tauriFetch(input, init)
}

nativeFetch.preconnect = () => Promise.resolve(false)
