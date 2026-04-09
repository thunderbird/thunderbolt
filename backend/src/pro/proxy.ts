import { getCorsOriginsList, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * General-purpose proxy routes
 * Proxies GET requests to external URLs with CORS headers
 */
export const createProxyRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()
  const safeFetchFn = createSafeFetch(fetchFn)

  return new Elysia({
    prefix: '/proxy',
  })
    .onError(safeErrorHandler)
    .use(
      cors({
        origin: getCorsOriginsList(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .get('/*', async (ctx) => {
      const url = new URL(ctx.request.url)

      // Extract the target URL from the path (everything after /proxy/)
      // Remove the prefix path to get the target URL
      const pathParts = url.pathname.split('/proxy/')
      let pathOnly: string
      try {
        pathOnly = decodeURIComponent(pathParts[pathParts.length - 1])
      } catch {
        ctx.set.status = 400
        return new Response('Invalid URL encoding', {
          headers: {
            'Content-Type': 'text/plain',
          },
        })
      }
      const targetUrl = pathOnly + url.search

      if (!targetUrl) {
        ctx.set.status = 400
        return new Response('No URL provided', {
          headers: {
            'Content-Type': 'text/plain',
          },
        })
      }

      const validation = validateSafeUrl(targetUrl)
      if (!validation.valid) {
        ctx.set.status = 400
        return new Response(validation.error || 'Invalid URL provided', {
          headers: {
            'Content-Type': 'text/plain',
          },
        })
      }

      try {
        // Make the proxied request
        const response = await safeFetchFn(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ThunderboltBot/1.0)',
          },
        })

        if (!response.ok) {
          ctx.set.status = response.status
          return new Response(`Failed to fetch resource: ${response.statusText}`, {
            headers: {
              'Content-Type': 'text/plain',
            },
          })
        }

        // Create response headers
        const responseHeaders = new Headers()

        // Copy relevant headers from the original response
        const headersToForward = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']
        headersToForward.forEach((header) => {
          const value = response.headers.get(header)
          if (value) {
            responseHeaders.set(header, value)
          }
        })

        // Prevent XSS: proxied content must never execute scripts in our origin
        responseHeaders.set('content-security-policy', 'sandbox')
        responseHeaders.set('content-disposition', 'attachment')
        responseHeaders.set('x-content-type-options', 'nosniff')

        // Add cross-origin resource policy header (CORS plugin handles Access-Control-* headers)
        responseHeaders.set('cross-origin-resource-policy', 'cross-origin')

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        })
      } catch (error) {
        console.error('Proxy error:', error)
        ctx.set.status = 500
        return new Response('Proxy request failed', {
          headers: {
            'Content-Type': 'text/plain',
          },
        })
      }
    })
}
