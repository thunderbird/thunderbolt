import { getAuthToken } from '@/lib/auth-token'
import { createClient, type HttpClient } from '@/lib/http'

let instance: HttpClient | null = null

/**
 * Create the app-wide authenticated HTTP client.
 * Called once during app initialization after cloudUrl is known.
 */
export const initHttpClient = (prefixUrl: string): HttpClient => {
  instance = createClient({
    prefixUrl,
    hooks: {
      beforeRequest: [
        (request) => {
          const token = getAuthToken()
          if (token) {
            request.headers.set('Authorization', `Bearer ${token}`)
          }
        },
      ],
    },
  })
  return instance
}

/** Get the app-wide authenticated HTTP client. Throws if not yet initialized. */
export const getHttpClient = (): HttpClient => {
  if (!instance) {
    throw new Error('HTTP client not initialized. Call initHttpClient() first.')
  }
  return instance
}
