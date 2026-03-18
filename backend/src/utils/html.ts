import { resolveUrl } from './url'

/** Decodes HTML entities (numeric and named) in a string */
export const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // Must be last to avoid double-decoding

/**
 * Extracts Open Graph metadata from HTML content.
 * Only falls back to <title> and <meta description> when at least one social
 * meta tag (og:*) is present — pages without any social tags
 * (e.g. captcha/block pages) return all nulls instead of garbage fallback text.
 */
export const extractMetadata = (html: string, url: string) => {
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

  return { title, description, image, siteName }
}
