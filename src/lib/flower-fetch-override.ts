/**
 * Global fetch override to redirect Flower API requests to localhost
 * 
 * This is a temporary workaround until Flower officially supports baseUrl configuration.
 * It intercepts all requests to api.flower.ai and redirects them to the configured localhost URL.
 */

import { getCloudUrl } from './config'

const FLOWER_API_URL = 'https://api.flower.ai'
let cloudUrl: string | null = null

// Cache the cloudUrl to avoid async calls in the fetch override
const initializeCloudUrl = async () => {
  if (!cloudUrl) {
    try {
      cloudUrl = await getCloudUrl()
    } catch (error) {
      console.warn('⚠️ Could not get cloudUrl for Flower redirect, using fallback:', (error as Error).message)
      // Fallback to default localhost URL
      cloudUrl = 'http://localhost:8000'
    }
  }
}

// Initialize immediately (but don't block)
initializeCloudUrl().catch(() => {
  // Ignore errors during initial setup - we'll retry on first request
})

const originalFetch = globalThis.fetch

/**
 * Override global fetch to redirect Flower API requests to localhost
 */
const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // Handle both URL objects and strings
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  
  // Check if this is a request to api.flower.ai
  if (url.includes('api.flower.ai')) {
    // Ensure we have the cloudUrl
    if (!cloudUrl) {
      await initializeCloudUrl()
    }
    
    if (cloudUrl) {
      // Replace api.flower.ai with localhost/flower
      const redirectedUrl = url.replace(FLOWER_API_URL, `${cloudUrl}/flower`)
      
      console.log(`🔄 Redirecting Flower API request:`)
      console.log(`   From: ${url}`)
      console.log(`   To:   ${redirectedUrl}`)
      
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
            ...init
          })
          return originalFetch(newRequest)
        }
      } catch (error) {
        console.error(`❌ Error redirecting Flower request to ${redirectedUrl}:`, error)
        // Fall back to original request if redirect fails
        return originalFetch(input, init)
      }
    } else {
      console.error('❌ Could not redirect Flower request - no cloudUrl available')
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

/**
 * Update the cloud URL used for redirects
 * Useful if the cloud URL changes during runtime
 */
export const updateCloudUrl = async () => {
  cloudUrl = await getCloudUrl()
  console.log(`📡 Updated Flower redirect URL to: ${cloudUrl}/flower`)
}

console.log('🌸 Flower fetch override initialized - all api.flower.ai requests will be redirected to localhost')