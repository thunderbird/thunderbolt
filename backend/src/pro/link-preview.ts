import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'
import type { LinkPreviewResponse } from './types'

/**
 * Decodes HTML entities in a string
 */
const decodeHtmlEntities = (text: string): string => {
  return text
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // Must be last to avoid double-decoding
}

/**
 * Resolves a potentially relative URL to an absolute URL
 */
const resolveUrl = (baseUrl: string, relativeUrl: string): string => {
  try {
    return new URL(relativeUrl, baseUrl).href
  } catch {
    return relativeUrl
  }
}

/**
 * Extracts Open Graph metadata from HTML content.
 * Only falls back to <title> and <meta description> when at least one social
 * meta tag (og:* or twitter:image) is present — pages without any social tags
 * (e.g. captcha/block pages) return all nulls instead of garbage fallback text.
 */
const extractMetadata = (html: string, url: string) => {
  // Extract social meta tags
  const ogTitleMatch =
    html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)
  const ogDescMatch =
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i)
  const imageMatch =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i) ||
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i)

  const hasSocialTags = !!(ogTitleMatch || ogDescMatch || imageMatch)

  // Only use non-social fallbacks when the page has at least one social tag
  const titleMatch = hasSocialTags ? html.match(/<title[^>]*>([^<]+)<\/title>/i) : null
  const metaDescMatch = hasSocialTags
    ? html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
    : null

  const rawImage = imageMatch?.[1] || null
  const image = rawImage ? resolveUrl(url, rawImage) : null
  const rawTitle = ogTitleMatch?.[1] || titleMatch?.[1] || null
  const rawDescription = ogDescMatch?.[1] || metaDescMatch?.[1] || null

  // Trim whitespace and decode HTML entities, return null if empty after trimming
  const title = rawTitle?.trim() ? decodeHtmlEntities(rawTitle.trim()) : null
  const description = rawDescription?.trim() ? decodeHtmlEntities(rawDescription.trim()) : null

  return {
    title,
    description,
    image,
  }
}

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

      // Extract the target URL from the path (everything after /link-preview/)
      const pathParts = url.pathname.split('/link-preview/')
      let pathOnly: string
      try {
        pathOnly = decodeURIComponent(pathParts[pathParts.length - 1])
      } catch {
        return {
          data: null,
          success: false,
          error: 'Invalid URL encoding',
        }
      }
      // Only append query string if the decoded path doesn't already contain one
      // This prevents double-adding query params if the original URL had them encoded in the path
      const targetUrl = pathOnly.includes('?') ? pathOnly : pathOnly + url.search

      if (!targetUrl) {
        return {
          data: null,
          success: false,
          error: 'No URL provided',
        }
      }

      // Validate that it's a valid URL with http/https protocol
      try {
        const parsedUrl = new URL(targetUrl)
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return {
            data: null,
            success: false,
            error: 'Only HTTP and HTTPS URLs are supported',
          }
        }
      } catch {
        return {
          data: null,
          success: false,
          error: 'Invalid URL provided',
        }
      }

      try {
        // Fetch with timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10_000)

        try {
          const response = await fetchFn(targetUrl, {
            method: 'GET',
            headers: {
              // Use a realistic user agent to avoid Forbidden errors
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

          // Keep timeout active during body download - this protects against slow streaming
          const html = await response.text()
          const metadata = extractMetadata(html, targetUrl)

          return {
            data: metadata,
            success: true,
          }
        } finally {
          // Always clear timeout after fetch and body download complete (or fail)
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
          error: error instanceof Error ? error.message : 'Link preview request failed',
        }
      }
    })
    .get('/image/*', async (ctx) => {
      const url = new URL(ctx.request.url)

      // Extract the image URL from the path (everything after /link-preview/image/)
      const pathParts = url.pathname.split('/link-preview/image/')
      let pathOnly: string
      try {
        pathOnly = decodeURIComponent(pathParts[pathParts.length - 1])
      } catch {
        ctx.set.status = 400
        return new Response('Invalid URL encoding', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }
      // Only append query string if the decoded path doesn't already contain one
      const imageUrl = pathOnly.includes('?') ? pathOnly : pathOnly + url.search

      if (!imageUrl) {
        ctx.set.status = 400
        return new Response('No image URL provided', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      // Validate that it's a valid URL with http/https protocol
      try {
        const parsedUrl = new URL(imageUrl)
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          ctx.set.status = 400
          return new Response('Only HTTP and HTTPS URLs are supported', {
            headers: { 'Content-Type': 'text/plain' },
          })
        }
      } catch {
        ctx.set.status = 400
        return new Response('Invalid image URL provided', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      try {
        // Fetch image with tight timeout and size limits
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 2000)

        try {
          const response = await fetchFn(imageUrl, {
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
            signal: controller.signal,
          })

          if (!response.ok) {
            ctx.set.status = response.status
            const errorMessage = response.statusText || `HTTP ${response.status}`
            return new Response(`Failed to fetch image: ${errorMessage}`, {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          // Check Content-Length header to avoid downloading huge images
          const contentLength = response.headers.get('content-length')
          const maxSizeBytes = 2 * 1024 * 1024 // 2MB limit
          const parsedLength = contentLength ? parseInt(contentLength, 10) : null
          if (parsedLength !== null && !Number.isNaN(parsedLength) && parsedLength > maxSizeBytes) {
            ctx.set.status = 413
            return new Response('Image too large', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          // Keep timeout active during body download - this protects against slow streaming
          const buffer = await response.arrayBuffer()

          // Double-check actual size (in case Content-Length was missing/wrong)
          if (buffer.byteLength > maxSizeBytes) {
            ctx.set.status = 413
            return new Response('Image too large', {
              headers: { 'Content-Type': 'text/plain' },
            })
          }

          // Use response content-type if valid, otherwise infer from URL extension
          const headerContentType = response.headers.get('content-type')
          let contentType: string
          if (headerContentType && headerContentType.startsWith('image/')) {
            contentType = headerContentType
          } else {
            // Header missing or invalid, try to infer from URL extension
            try {
              const parsedImageUrl = new URL(imageUrl)
              const ext = parsedImageUrl.pathname.split('.').pop()?.toLowerCase()
              if (ext === 'png') contentType = 'image/png'
              else if (ext === 'gif') contentType = 'image/gif'
              else if (ext === 'webp') contentType = 'image/webp'
              else if (ext === 'svg') contentType = 'image/svg+xml'
              else contentType = 'image/jpeg' // Default fallback
            } catch {
              contentType = 'image/jpeg' // Default fallback
            }
          }

          return new Response(buffer, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=86400', // Cache for 1 day
            },
          })
        } finally {
          // Always clear timeout after fetch and body download complete (or fail)
          clearTimeout(timeoutId)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          ctx.set.status = 408
          return new Response('Image fetch timeout', {
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
}
