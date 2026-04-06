import { getCorsOrigins, getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
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

/** Decodes a URL path parameter, returning null on invalid encoding */
const decodeUrlParam = (encoded: string): string | null => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

/**
 * Fetches and proxies an image with size limits and timeout.
 * Returns a Response with the image data or an error response.
 */
const fetchAndProxyImage = async (
  imageUrl: string,
  fetchFn: typeof fetch,
  ctx: { set: { status?: number | string } },
): Promise<Response> => {
  try {
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

      const contentLength = response.headers.get('content-length')
      const maxSizeBytes = 2 * 1024 * 1024 // 2MB limit
      const parsedLength = contentLength ? parseInt(contentLength, 10) : null
      if (parsedLength !== null && !Number.isNaN(parsedLength) && parsedLength > 0 && parsedLength > maxSizeBytes) {
        ctx.set.status = 413
        return new Response('Image too large', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const buffer = await response.arrayBuffer()

      if (buffer.byteLength > maxSizeBytes) {
        ctx.set.status = 413
        return new Response('Image too large', {
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const contentType = inferImageContentType(response.headers.get('content-type'), imageUrl)

      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      })
    } finally {
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
}

/** Infers image content type from response header or URL extension */
const inferImageContentType = (headerContentType: string | null, imageUrl: string): string => {
  if (headerContentType && headerContentType.startsWith('image/')) {
    return headerContentType
  }
  try {
    const ext = new URL(imageUrl).pathname.split('.').pop()?.toLowerCase()
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'svg') return 'image/svg+xml'
    return 'image/jpeg'
  } catch {
    return 'image/jpeg'
  }
}

/**
 * Extracts Open Graph metadata from HTML content.
 * Only falls back to <title> and <meta description> when at least one social
 * meta tag (og:*) is present — pages without any social tags
 * (e.g. captcha/block pages) return all nulls instead of garbage fallback text.
 */
const extractMetadata = (html: string, url: string) => {
  const ogTitleMatch =
    html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)
  const ogDescMatch =
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i)
  const imageMatch =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i)
  const siteNameMatch =
    html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["'][^>]*>/i)

  const hasSocialTags = !!(ogTitleMatch || ogDescMatch || imageMatch || siteNameMatch)

  const titleMatch = hasSocialTags ? html.match(/<title[^>]*>([^<]+)<\/title>/i) : null
  const metaDescMatch = hasSocialTags
    ? html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
    : null

  const rawImage = imageMatch?.[1] || null
  const image = rawImage ? resolveUrl(url, rawImage) : null
  const rawTitle = ogTitleMatch?.[1] || titleMatch?.[1] || null
  const rawDescription = ogDescMatch?.[1] || metaDescMatch?.[1] || null

  const title = rawTitle?.trim() ? decodeHtmlEntities(rawTitle.trim()) : null
  const description = rawDescription?.trim() ? decodeHtmlEntities(rawDescription.trim()) : null
  const rawSiteName = siteNameMatch?.[1] || null
  const siteName = rawSiteName?.trim() ? decodeHtmlEntities(rawSiteName.trim()) : null

  return {
    title,
    description,
    image,
    siteName,
  }
}

/**
 * Link preview routes
 * Fetches and parses Open Graph metadata from URLs
 */
export const createLinkPreviewRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()
  const safeFetchFn = createSafeFetch(fetchFn)

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
          const response = await safeFetchFn(targetUrl, {
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
          const response = await safeFetchFn(fullPageUrl, {
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

          return fetchAndProxyImage(metadata.image, safeFetchFn, ctx)
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

      return fetchAndProxyImage(fullImageUrl, safeFetchFn, ctx)
    })
}
