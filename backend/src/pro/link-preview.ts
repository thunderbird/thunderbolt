import { getCorsOrigins, getSettings } from '@/config/settings'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'
import type { LinkPreviewResponse } from './types'

const TIMEOUT_MS = 2000

/**
 * Extracts Open Graph metadata from HTML content
 */
const extractMetadata = (html: string, url: string) => {
  // Extract og:image or fallback to any meta image
  const imageMatch =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i) ||
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["'][^>]*>/i)
  const image = imageMatch?.[1] || null

  // Extract og:title or fallback to title tag
  const ogTitleMatch =
    html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = ogTitleMatch?.[1] || titleMatch?.[1] || null

  // Extract og:description or fallback to meta description
  const ogDescMatch =
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i)
  const metaDescMatch =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
  const description = ogDescMatch?.[1] || metaDescMatch?.[1] || null

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
export const createLinkPreviewRoutes = () => {
  const settings = getSettings()

  return new Elysia({
    prefix: '/link-preview',
  })
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
      const pathOnly = decodeURIComponent(pathParts[pathParts.length - 1])
      const targetUrl = pathOnly + url.search

      if (!targetUrl) {
        return {
          data: null,
          success: false,
          error: 'No URL provided',
        }
      }

      // Validate that it's a valid URL
      try {
        new URL(targetUrl)
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
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

        const response = await fetch(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ThunderboltBot/1.0)',
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

        return {
          data: metadata,
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
