import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { extractMetadata } from '@/utils/html'
import { fetchAndProxyImage } from '@/utils/image'
import { decodeUrlParam, validateSafeUrl } from '@/utils/url'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'
import type { LinkPreviewResponse } from './types'

/**
 * Link preview routes
 * Fetches and parses Open Graph metadata from URLs
 */
export const createLinkPreviewRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()

  return new Elysia({
    prefix: '/link-preview',
  })
    .onError(safeErrorHandler)
    .use(
      cors({
        origin: getCorsOrigins(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .get('/*', async (ctx): Promise<LinkPreviewResponse> => {
      const url = new URL(ctx.request.url)

      const pathParts = url.pathname.split('/link-preview/')
      if (pathParts.length < 2 || !pathParts[pathParts.length - 1]) {
        return {
          data: null,
          success: false,
          error: 'No URL provided',
        }
      }

      const pathOnly = decodeUrlParam(pathParts[pathParts.length - 1])
      if (!pathOnly) {
        return {
          data: null,
          success: false,
          error: 'Invalid URL encoding',
        }
      }
      const targetUrl = pathOnly.includes('?') ? pathOnly : pathOnly + url.search

      if (!targetUrl || !targetUrl.trim()) {
        return {
          data: null,
          success: false,
          error: 'No URL provided',
        }
      }

      const validation = validateSafeUrl(targetUrl)
      if (!validation.valid) {
        return {
          data: null,
          success: false,
          error: validation.error || 'Invalid URL provided',
        }
      }

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10_000)

        try {
          const response = await fetchFn(targetUrl, {
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: controller.signal,
          })

          if (!response.ok) {
            return {
              data: null,
              success: false,
              error: `Failed to fetch resource: ${response.statusText}`,
            }
          }

          const maxHtmlBytes = 2 * 1024 * 1024 // 2MB limit for HTML metadata extraction
          const contentLength = response.headers.get('content-length')
          const parsedLength = contentLength ? parseInt(contentLength, 10) : null
          if (parsedLength !== null && !Number.isNaN(parsedLength) && parsedLength > maxHtmlBytes) {
            return {
              data: null,
              success: false,
              error: 'Response too large',
            }
          }

          const buffer = await response.arrayBuffer()
          if (buffer.byteLength > maxHtmlBytes) {
            return {
              data: null,
              success: false,
              error: 'Response too large',
            }
          }

          const html = new TextDecoder().decode(buffer)
          const metadata = extractMetadata(html, targetUrl)

          return {
            data: metadata,
            success: true,
          }
        } finally {
          clearTimeout(timeoutId)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            data: null,
            success: false,
            error: 'Request timeout exceeded',
          }
        }

        console.error('Link preview error:', error)
        return {
          data: null,
          success: false,
          error: 'Link preview request failed',
        }
      }
    })
    .get('/image/*', async (ctx) => {
      const url = new URL(ctx.request.url)

      const pathParts = url.pathname.split('/link-preview/image/')
      if (pathParts.length < 2 || !pathParts[pathParts.length - 1]) {
        ctx.set.status = 400
        return new Response('No URL provided', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const pageUrl = decodeUrlParam(pathParts[pathParts.length - 1])
      if (!pageUrl) {
        ctx.set.status = 400
        return new Response('Invalid URL encoding', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const fullPageUrl = pageUrl.includes('?') ? pageUrl : pageUrl + url.search

      // Validate URL format and SSRF protection on page URL
      const pageValidation = validateSafeUrl(fullPageUrl)
      if (!pageValidation.valid) {
        ctx.set.status = 400
        return new Response(pageValidation.error || 'Invalid URL', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10_000)

        try {
          const response = await fetchFn(fullPageUrl, {
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: controller.signal,
          })

          if (!response.ok) {
            ctx.set.status = response.status
            return new Response(`Failed to fetch page: ${response.statusText}`, {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const maxHtmlBytes = 2 * 1024 * 1024 // 2MB limit for HTML metadata extraction
          const contentLength = response.headers.get('content-length')
          const parsedLength = contentLength ? parseInt(contentLength, 10) : null
          if (parsedLength !== null && !Number.isNaN(parsedLength) && parsedLength > maxHtmlBytes) {
            ctx.set.status = 413
            return new Response('Page response too large', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const buffer = await response.arrayBuffer()
          if (buffer.byteLength > maxHtmlBytes) {
            ctx.set.status = 413
            return new Response('Page response too large', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const html = new TextDecoder().decode(buffer)
          const metadata = extractMetadata(html, fullPageUrl)

          if (!metadata.image) {
            ctx.set.status = 404
            return new Response('No image found in page metadata', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          const validation = validateSafeUrl(metadata.image)
          if (!validation.valid) {
            ctx.set.status = 400
            return new Response(validation.error || 'Invalid image URL', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          return fetchAndProxyImage(metadata.image, fetchFn, ctx)
        } finally {
          clearTimeout(timeoutId)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          ctx.set.status = 408
          return new Response('Request timeout exceeded', {
            headers: { 'Content-Type': 'text/plain' },
          })
        }

        console.error('Link preview image error:', error)
        ctx.set.status = 500
        return new Response('Image fetch failed', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }
    })
    .get('/proxy-image/*', async (ctx) => {
      const url = new URL(ctx.request.url)

      const pathParts = url.pathname.split('/link-preview/proxy-image/')
      if (pathParts.length < 2 || !pathParts[pathParts.length - 1]) {
        ctx.set.status = 400
        return new Response('No image URL provided', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const imageUrl = decodeUrlParam(pathParts[pathParts.length - 1])
      if (!imageUrl) {
        ctx.set.status = 400
        return new Response('Invalid URL encoding', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const fullImageUrl = imageUrl.includes('?') ? imageUrl : imageUrl + url.search

      const validation = validateSafeUrl(fullImageUrl)
      if (!validation.valid) {
        ctx.set.status = 400
        return new Response(validation.error || 'Invalid image URL', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      return fetchAndProxyImage(fullImageUrl, fetchFn, ctx)
    })
}
