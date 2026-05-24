/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import { createSafeFetch, ensureHttps, validateSafeUrl, type DnsLookup } from '@/utils/url-validation'
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

const emptyPreview: PreviewDto = { previewImageUrl: null, summary: null, title: null, siteName: null }

/** Read up to `maxBytes` from a body stream, returning null if the cap is exceeded.
 *  Avoids buffering an entire response when Content-Length is missing or lying. */
const readCappedBody = async (body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> => {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

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

const metaRegexCache = new Map<string, [RegExp, RegExp]>()
const getMetaRegex = (attr: 'property' | 'name', value: string): [RegExp, RegExp] => {
  const key = `${attr}:${value}`
  const cached = metaRegexCache.get(key)
  if (cached) {
    return cached
  }
  const pair: [RegExp, RegExp] = [
    new RegExp(`<meta[^>]*${attr}=["']${value}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${value}["'][^>]*>`, 'i'),
  ]
  metaRegexCache.set(key, pair)
  return pair
}

/** Match a meta tag in either content-first or property-first form. */
const matchMeta = (html: string, attr: 'property' | 'name', value: string): string | null => {
  const [propertyFirst, contentFirst] = getMetaRegex(attr, value)
  return html.match(propertyFirst)?.[1] ?? html.match(contentFirst)?.[1] ?? null
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

export type CreatePreviewRoutesOptions = {
  auth: Auth
  fetchFn?: typeof fetch
  rateLimit?: AnyElysia
  dnsLookup?: DnsLookup
}

export const createPreviewRoutes = (options: CreatePreviewRoutesOptions) => {
  const { auth, rateLimit, dnsLookup } = options
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const safeFetch = createSafeFetch(fetchFn, dnsLookup)

  return new Elysia({ name: 'preview-routes' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) {
        g.use(rateLimit)
      }
      // POST so target URLs do not appear in access logs.
      return g.post(
        '/preview',
        async ({ body, set }): Promise<PreviewDto | { error: string }> => {
          const targetUrl = body.url
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
              return emptyPreview
            }
            const contentLength = response.headers.get('content-length')
            const parsed = contentLength ? parseInt(contentLength, 10) : null
            if (parsed !== null && Number.isFinite(parsed) && parsed > maxHtmlBytes) {
              return emptyPreview
            }
            if (!response.body) {
              return emptyPreview
            }
            const buffer = await readCappedBody(response.body, maxHtmlBytes)
            if (!buffer) {
              return emptyPreview
            }
            const html = new TextDecoder().decode(buffer)
            // Cache successful OG metadata per-user for 10 minutes. Safe here (unlike
            // /v1/proxy) because the response is a small, derived JSON DTO — not the
            // raw upstream body — and the request body is the only cache key (no
            // `?token=` style explosion). `private` keeps shared/CDN caches out.
            // Only set on the success path so transient upstream failures (empty
            // fallback) aren't sticky for 10 minutes.
            set.headers['Cache-Control'] = 'private, max-age=600'
            return extractMetadata(html, targetUrl)
          } catch {
            return emptyPreview
          } finally {
            clearTimeout(timeoutId)
          }
        },
        { body: t.Object({ url: t.String() }) },
      )
    })
}
