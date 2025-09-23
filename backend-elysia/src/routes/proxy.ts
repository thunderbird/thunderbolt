import { proxyService } from '@/proxy/service'
import type { ProxyContext } from '@/proxy/types'
import { Elysia } from 'elysia'

/**
 * Convert Elysia context to ProxyContext
 */
const createProxyContext = (ctx: any): ProxyContext => {
  const method = ctx.request.method as string
  const headers = { ...(ctx.headers || {}) } as Record<string, string>

  // Use Elysia's already-parsed body and convert to Uint8Array
  let body = new Uint8Array(0)
  let bodyWasReconstructed = false

  if (method !== 'GET' && method !== 'HEAD' && ctx.body !== undefined && ctx.body !== null) {
    if (ctx.body instanceof Uint8Array) {
      body = ctx.body
    } else if (typeof ctx.body === 'string') {
      body = new TextEncoder().encode(ctx.body)
      bodyWasReconstructed = true
    } else {
      // For objects, assume JSON unless content-type suggests otherwise
      const contentType = headers['content-type'] || ''
      if (contentType.includes('application/x-www-form-urlencoded')) {
        // Convert object to URL-encoded string
        const params = new URLSearchParams()
        for (const [key, value] of Object.entries(ctx.body as Record<string, any>)) {
          if (value !== undefined && value !== null) {
            params.append(key, String(value))
          }
        }
        body = new TextEncoder().encode(params.toString())
      } else {
        // Default to JSON
        body = new TextEncoder().encode(JSON.stringify(ctx.body))
      }
      bodyWasReconstructed = true
    }
  }

  // If we reconstructed the body, remove compression headers since it's no longer compressed
  if (bodyWasReconstructed) {
    delete headers['content-encoding']
    delete headers['content-length'] // Will be set by fetch
  }

  return {
    ...ctx,
    path: ctx.params['*'] || '',
    method,
    headers,
    query: ctx.query || {},
    body,
  }
}

/**
 * Create proxy routes
 */
export const createProxyRoutes = () => {
  return (
    new Elysia()
      // Flower AI proxy endpoints
      .all('/flower/*', async (ctx) => {
        const { set } = ctx

        // Get the configuration for this path
        const config = proxyService.getConfig('/flower')
        if (!config) {
          console.error('Flower AI proxy not configured')
          set.status = 404
          throw new Error('Flower AI proxy not configured')
        }

        // Convert to proxy context
        const proxyCtx = createProxyContext(ctx)

        // Extract path after /flower/
        const path = proxyCtx.path

        // Don't override the API key in config - the proxy will pass through existing headers
        config.apiKey = ''

        try {
          const response = await proxyService.proxyRequest(proxyCtx, path, config)
          return response
        } catch (error) {
          console.error('Flower proxy request failed:', error)
          set.status = 500
          throw error
        }
      })

      // OpenAI-compatible endpoints
      .all('/openai/*', async (ctx) => {
        const { set } = ctx

        // Get the configuration for this path
        const config = proxyService.getConfig('/openai')
        if (!config) {
          set.status = 404
          throw new Error('OpenAI proxy not configured')
        }

        // Convert to proxy context
        const proxyCtx = createProxyContext(ctx)

        // Extract path after /openai/
        const path = proxyCtx.path

        try {
          const response = await proxyService.proxyRequest(proxyCtx, path, config)
          return response
        } catch (error) {
          console.error('OpenAI proxy request failed:', error)
          set.status = 500
          throw error
        }
      })

      // PostHog Analytics proxy endpoint
      .all('/posthog/*', async (ctx) => {
        const { set } = ctx

        // Get the configuration for this path
        const config = proxyService.getConfig('/posthog')
        if (!config) {
          set.status = 404
          throw new Error('PostHog proxy not configured')
        }

        // Convert to proxy context
        const proxyCtx = createProxyContext(ctx)

        // Extract path after /posthog/
        const path = proxyCtx.path

        try {
          const response = await proxyService.proxyRequest(proxyCtx, path, config)

          // Fix CORS headers for browser compatibility
          if (response.headers) {
            const headers = new Headers(response.headers)

            // Remove any problematic headers
            const problematicHeaders = [
              'cross-origin-resource-policy',
              'cross-origin-embedder-policy',
              'cross-origin-opener-policy',
            ]

            problematicHeaders.forEach((header) => {
              headers.delete(header)
            })

            // Add browser-friendly CORS headers
            headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
            headers.set('Cross-Origin-Embedder-Policy', 'unsafe-none')
            headers.set('Cross-Origin-Opener-Policy', 'unsafe-none')

            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            })
          }

          return response
        } catch (error) {
          console.error('PostHog proxy request failed:', error)
          set.status = 500
          throw error
        }
      })

      // Generic proxy endpoint that routes based on path
      .all('/proxy/*', async (ctx) => {
        const { set } = ctx

        // Convert to proxy context
        const proxyCtx = createProxyContext(ctx)
        const fullPath = `/proxy/${proxyCtx.path}`

        // Get the configuration for this path
        const config = proxyService.getConfig(fullPath)
        if (!config) {
          set.status = 404
          throw new Error('Proxy path not configured')
        }

        // Verify authentication if required
        if (config.requireAuth && !proxyService.verifyAuth(proxyCtx)) {
          set.status = 401
          throw new Error('Unauthorized')
        }

        // Remove the proxy prefix from the path
        // Extract the actual path after the service name
        let actualPath = proxyCtx.path
        for (const prefix of proxyService['configs'].keys()) {
          if (fullPath.startsWith(prefix)) {
            const servicePrefix = prefix.replace('/proxy/', '')
            actualPath = proxyCtx.path.substring(servicePrefix.length)
            actualPath = actualPath.replace(/^\/+/, '') // Remove leading slashes
            break
          }
        }

        try {
          const response = await proxyService.proxyRequest(proxyCtx, actualPath, config)
          return response
        } catch (error) {
          console.error('Generic proxy request failed:', error)
          set.status = 500
          throw error
        }
      })
  )
}
