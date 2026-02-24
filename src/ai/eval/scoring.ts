import type { EvalCriteria, EvalResult, EvalScenario, ParsedStream } from './types'

const reviewSiteDomains = [
  'wirecutter.com',
  'pcmag.com',
  'cnet.com',
  'techradar.com',
  'rtings.com',
  'tomsguide.com',
  'consumerreports.org',
]

/** Extract [N] citation references from text (matches both ASCII [1] and fullwidth 【1】 brackets) */
export const extractCitations = (text: string): string[] => {
  const matches = text.match(/(?:\[\d+\]|【\d+】)/g)
  return matches ? [...new Set(matches)] : []
}

/** Extract URLs from <widget:link-preview url="..."> tags */
export const extractLinkPreviewUrls = (text: string): string[] =>
  [...text.matchAll(/url="(https?:\/\/[^"]+)"/g)].map((m) => m[1])

/** Extract all widget tags from the response (weather-forecast, link-preview, connect-integration) */
export const extractWidgets = (text: string): string[] => [...text.matchAll(/<widget:([a-z-]+)/g)].map((m) => m[1])

/**
 * Known navigation-only path segments that indicate aggregate/section pages.
 * Single-segment paths like /async-io-python/ are usually articles, NOT homepages.
 */
const sectionPaths = new Set([
  '/news',
  '/news/',
  '/ai',
  '/ai/',
  '/tech',
  '/tech/',
  '/technology',
  '/technology/',
  '/business',
  '/business/',
  '/science',
  '/science/',
  '/health',
  '/health/',
  '/sections',
  '/hub',
  '/category',
  '/categories',
  '/topics',
  '/tags',
])

const genericSubdomains = new Set(['www', 'm', 'mobile', 'app', 'api', 'cdn', 'static'])

/**
 * Check if a URL is a true homepage or navigation section page.
 * A bare domain root (/) is a homepage UNLESS the subdomain is specific
 * (e.g., server-components.epicreact.dev/ is a content app, not a homepage).
 * Known section paths (/news/, /ai/, /technology/) are section pages.
 * Single-segment slugs (/async-io-python/, /how-to-work-from-home) are typically articles.
 */
export const isHomepage = (url: string): boolean => {
  try {
    const { pathname, hostname } = new URL(url)
    if (pathname === '/') {
      // Specific subdomains (not www/m/app) are content apps, not homepages
      const parts = hostname.split('.')
      if (parts.length >= 3 && !genericSubdomains.has(parts[0])) return false
      return true
    }
    // Check against known section paths
    const normalized = pathname.toLowerCase().replace(/\/+$/, '')
    return sectionPaths.has(normalized) || sectionPaths.has(normalized + '/')
  } catch {
    return false
  }
}

/** Check if a URL belongs to a known review/aggregate site */
export const isReviewSite = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.replace('www.', '')
    return reviewSiteDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

/** Score a parsed response against scenario criteria */
export const scoreResult = (scenario: EvalScenario, parsed: ParsedStream, durationMs: number): EvalResult => {
  const { criteria } = scenario
  const failures: string[] = []

  const citations = extractCitations(parsed.text)
  const widgets = extractWidgets(parsed.text)
  const linkPreviewUrls = extractLinkPreviewUrls(parsed.text)
  const homepageUrls = linkPreviewUrls.filter(isHomepage)
  const reviewSiteUrls = linkPreviewUrls.filter(isReviewSite)

  if (parsed.error) {
    failures.push(`Error: ${parsed.error}`)
  }

  checkCriteria(criteria, parsed, citations, linkPreviewUrls, homepageUrls, reviewSiteUrls, failures)

  return {
    scenario,
    passed: failures.length === 0,
    failures,
    responseText: parsed.text,
    responseLength: parsed.text.length,
    citations,
    widgets,
    linkPreviewUrls,
    homepageUrls,
    reviewSiteUrls,
    toolCallCount: parsed.toolCalls.length,
    retryCount: parsed.retryCount,
    durationMs: Math.round(durationMs),
    error: parsed.error,
  }
}

const checkCriteria = (
  criteria: EvalCriteria,
  parsed: ParsedStream,
  citations: string[],
  linkPreviewUrls: string[],
  homepageUrls: string[],
  reviewSiteUrls: string[],
  failures: string[],
) => {
  if (criteria.mustProduceOutput && parsed.text.trim().length === 0) {
    failures.push('Empty response — no text output produced')
  }

  if (criteria.minCitations !== undefined && citations.length < criteria.minCitations) {
    failures.push(`Insufficient citations: ${citations.length} found, ${criteria.minCitations} required`)
  }

  if (criteria.mustUseLinkPreviews && linkPreviewUrls.length === 0) {
    failures.push('No <widget:link-preview> tags found in response')
  }

  if (criteria.noHomepageLinks && homepageUrls.length > 0) {
    failures.push(`Homepage/section URLs found: ${homepageUrls.join(', ')}`)
  }

  if (criteria.noReviewSites && reviewSiteUrls.length > 0) {
    failures.push(`Review site URLs found: ${reviewSiteUrls.join(', ')}`)
  }

  if (criteria.maxSteps !== undefined && parsed.stepCount > criteria.maxSteps) {
    failures.push(`Too many steps: ${parsed.stepCount} (max: ${criteria.maxSteps})`)
  }
}
