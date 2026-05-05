/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { Elysia, t, type AnyElysia } from 'elysia'

export type PreviewDto = {
  previewImageUrl: string | null
  summary: string | null
  title: string | null
  siteName: string | null
}

const maxHtmlBytes = 2 * 1024 * 1024
const fetchTimeoutMs = 10_000
const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const resolveUrl = (baseUrl: string, relativeUrl: string): string => {
  try {
    return new URL(relativeUrl, baseUrl).href
  } catch {
    return relativeUrl
  }
}

const ensureHttps = (raw: string | null | undefined): string | null => {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return u.toString()
    if (u.protocol === 'http:') {
      u.protocol = 'https:'
      return u.toString()
    }
    return null
  } catch {
    return null
  }
}

/** Match a meta tag in either content-first or property-first form. */
const matchMeta = (html: string, attr: 'property' | 'name', value: string): string | null => {
  const a = html.match(new RegExp(`<meta[^>]*${attr}=["']${value}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'))
  if (a) return a[1]
  const b = html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${value}["'][^>]*>`, 'i'))
  return b ? b[1] : null
}

const extractMetadata = (html: string, baseUrl: string): PreviewDto => {
  const ogTitle = matchMeta(html, 'property', 'og:title')
  const ogDesc = matchMeta(html, 'property', 'og:description')
  const ogImage = matchMeta(html, 'property', 'og:image')
  const ogSite = matchMeta(html, 'property', 'og:site_name')
  const hasSocial = ogTitle || ogDesc || ogImage || ogSite

  const fallbackTitle = hasSocial ? (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? null) : null
  const metaDesc = hasSocial ? matchMeta(html, 'name', 'description') : null

  const decode = (s: string | null) => (s?.trim() ? decodeHtmlEntities(s.trim()) : null)
  const previewImageUrl = ogImage ? ensureHttps(resolveUrl(baseUrl, ogImage)) : null
  return {
    previewImageUrl,
    summary: decode(ogDesc) ?? decode(metaDesc),
    title: decode(ogTitle) ?? decode(fallbackTitle),
    siteName: decode(ogSite),
  }
}

export const createPreviewRoutes = (auth: Auth, fetchFn: typeof fetch = globalThis.fetch, rateLimit?: AnyElysia) => {
  const safeFetch = createSafeFetch(fetchFn)

  return new Elysia({ name: 'preview-routes' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) g.use(rateLimit)
      return g.get(
        '/preview',
        async ({ query, set }): Promise<PreviewDto | { error: string }> => {
          const targetUrl = query.url
          const validation = validateSafeUrl(targetUrl)
          if (!validation.valid) {
            set.status = 400
            return { error: validation.error ?? 'Invalid URL' }
          }

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs)
          try {
            const response = await safeFetch(targetUrl, {
              method: 'GET',
              headers: {
                'User-Agent': userAgent,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              signal: controller.signal,
            })

            if (!response.ok) {
              set.status = response.status
              return { error: `Upstream returned ${response.status}` }
            }

            const contentLength = response.headers.get('content-length')
            const parsed = contentLength ? parseInt(contentLength, 10) : null
            if (parsed !== null && Number.isFinite(parsed) && parsed > maxHtmlBytes) {
              set.status = 413
              return { error: 'Page too large' }
            }
            const buffer = await response.arrayBuffer()
            if (buffer.byteLength > maxHtmlBytes) {
              set.status = 413
              return { error: 'Page too large' }
            }
            const html = new TextDecoder().decode(buffer)
            return extractMetadata(html, targetUrl)
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              set.status = 408
              return { error: 'Upstream timed out' }
            }
            set.status = 502
            return { error: 'Preview fetch failed' }
          } finally {
            clearTimeout(timeoutId)
          }
        },
        { query: t.Object({ url: t.String() }) },
      )
    })
}
