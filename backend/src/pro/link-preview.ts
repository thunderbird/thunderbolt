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

        clearTimeout(timeoutId)

        if (!response.ok) {
          return {
            data: null,
            success: false,
            error: `Failed to fetch resource: ${response.statusText}`,
          }
        }

        const html = await response.text()
        const metadata = extractMetadata(html, targetUrl)

        // Try to inline the image as a data URL to save a round trip.
        // Uses a tight 2s timeout and 2MB size limit so slow/large images fall back to the proxy.
        let imageData: string | null = null
        if (metadata.image) {
          try {
            // Validate image URL protocol (http/https only)
            const imageUrl = new URL(metadata.image)
            if (!['http:', 'https:'].includes(imageUrl.protocol)) {
              // Skip inlining for non-HTTP(S) URLs
            } else {
              const imgController = new AbortController()
              const imgTimeout = setTimeout(() => imgController.abort(), 2000)
              const imgResponse = await fetchFn(metadata.image, {
                method: 'GET',
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
                signal: imgController.signal,
              })
              clearTimeout(imgTimeout)

              if (imgResponse.ok) {
                // Check Content-Length header to avoid downloading huge images
                const contentLength = imgResponse.headers.get('content-length')
                const maxSizeBytes = 2 * 1024 * 1024 // 2MB limit
                const parsedLength = contentLength ? parseInt(contentLength, 10) : null
                if (parsedLength !== null && !Number.isNaN(parsedLength) && parsedLength > maxSizeBytes) {
                  // Image too large, skip inlining
                } else {
                  const buffer = await imgResponse.arrayBuffer()
                  // Double-check actual size (in case Content-Length was missing/wrong)
                  if (buffer.byteLength > maxSizeBytes) {
                    // Image too large, skip inlining
                  } else {
                    // Infer content type from URL extension if header is missing or invalid
                    const headerContentType = imgResponse.headers.get('content-type')
                    let contentType = 'image/jpeg' // Default fallback

                    // Use header content-type if it's a valid image type
                    if (headerContentType && headerContentType.startsWith('image/')) {
                      contentType = headerContentType
                    } else {
                      // Header missing or invalid, try to infer from URL extension
                      try {
                        const url = new URL(metadata.image)
                        const ext = url.pathname.split('.').pop()?.toLowerCase()
                        if (ext === 'png') contentType = 'image/png'
                        else if (ext === 'gif') contentType = 'image/gif'
                        else if (ext === 'webp') contentType = 'image/webp'
                        else if (ext === 'svg') contentType = 'image/svg+xml'
                      } catch {
                        // URL parsing failed, use default
                      }
                    }
                    imageData = `data:${contentType};base64,${Buffer.from(buffer).toString('base64')}`
                  }
                }
              }
            }
          } catch {
            // Image fetch failed, timed out, or URL validation failed — client will fall back to proxy
          }
        }

        return {
          data: { ...metadata, imageData },
          success: true,
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
}
