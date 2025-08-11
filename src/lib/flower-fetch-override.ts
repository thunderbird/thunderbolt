/**
 * Global fetch override to redirect Flower API requests to localhost
 *
 * This is a temporary workaround until Flower officially supports baseUrl configuration.
 * It intercepts all requests to api.flower.ai and redirects them to the configured localhost URL.
 */

import { getCloudUrl } from './config'

const FLOWER_API_URL = 'https://api.flower.ai'

const originalFetch = globalThis.fetch

/**
 * Override global fetch to redirect Flower API requests to localhost
 */
const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // Handle both URL objects and strings
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

  // Check if this is a request to api.flower.ai
  if (url.includes('api.flower.ai')) {
    const cloudUrl = await getCloudUrl()

    // Replace api.flower.ai with localhost/flower
    const redirectedUrl = url.replace(FLOWER_API_URL, `${cloudUrl}/flower`)

    try {
      // Create new request with redirected URL
      if (typeof input === 'string') {
        return originalFetch(redirectedUrl, init)
      } else if (input instanceof URL) {
        return originalFetch(new URL(redirectedUrl), init)
      } else {
        // Request object - create a new one with the redirected URL
        const newRequest = new Request(redirectedUrl, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          mode: init?.mode || input.mode,
          credentials: init?.credentials || input.credentials,
          cache: init?.cache || input.cache,
          redirect: init?.redirect || input.redirect,
          referrer: input.referrer,
          integrity: input.integrity,
          ...init,
        })
        return originalFetch(newRequest)
      }
    } catch (error) {
      console.error(`❌ Error redirecting Flower request to ${redirectedUrl}:`, error)
      // Fall back to original request if redirect fails
      return originalFetch(input, init)
    }
  }

  // For all other requests, use the original fetch
  return originalFetch(input, init)
}

// Apply the custom fetch
globalThis.fetch = customFetch as typeof fetch

/**
 * Restore the original fetch function
 * Call this if you need to disable the override for any reason
 */
export const restoreOriginalFetch = () => {
  globalThis.fetch = originalFetch
}
