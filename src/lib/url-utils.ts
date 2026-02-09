/**
 * Validates that a URL uses a safe protocol (http or https).
 * Returns false for javascript:, data:, and other potentially dangerous schemes.
 */
export const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Returns a proxied favicon URL to bypass CORS/COEP restrictions.
 * Falls back to the original URL if no proxy base is provided.
 */
export const getProxiedFaviconUrl = (faviconUrl: string, proxyBase: string): string => {
  if (!proxyBase) return faviconUrl
  return `${proxyBase}/pro/proxy/${encodeURIComponent(faviconUrl)}`
}

/**
 * Derives a /favicon.ico URL from a page URL's origin, optionally proxied.
 * Returns null if the URL is invalid.
 */
export const deriveFaviconUrl = (pageUrl: string, proxyBase?: string): string | null => {
  try {
    const { origin } = new URL(pageUrl)
    const faviconUrl = `${origin}/favicon.ico`
    return proxyBase ? getProxiedFaviconUrl(faviconUrl, proxyBase) : faviconUrl
  } catch {
    return null
  }
}
