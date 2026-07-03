/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deriveFaviconUrl } from '../../../shared/url'
import type { SearchResult } from './search'

/**
 * Keyless DuckDuckGo search via the HTML endpoint. This is UNOFFICIAL and
 * FRAGILE: DuckDuckGo throttles the HTML endpoint to roughly 30 requests/minute
 * and can change its markup at any time without notice. Treat it as a
 * best-effort free tier, not a reliable API.
 *
 * Shared by web + desktop: desktop passes a direct `fetch`; web passes a
 * `/v1/proxy` fetch to get around browser CORS. The caller decides which.
 *
 * Fails gracefully — returns `[]` when the markup can't be parsed; only a
 * network error or a non-OK response throws.
 */
export const freeSearchDuckDuckGo = async (
  query: string,
  fetchFn: typeof fetch,
  numResults = 10,
): Promise<SearchResult[]> => {
  const url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query)
  const res = await fetchFn(url.toString(), { method: 'GET' })
  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed (${res.status})`)
  }
  return parseDuckDuckGoHtml(await res.text(), numResults)
}

const entities: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
}

/** Strip tags and decode the handful of HTML entities DuckDuckGo emits. */
const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#x27;|&#39;/g, (m) => entities[m])
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Resolve a DuckDuckGo result href to the real destination. DDG wraps links as
 * `//duckduckgo.com/l/?uddg=<url-encoded>&rut=...`; decode the `uddg` param.
 * Bare protocol-relative hrefs are upgraded to https.
 */
const decodeDuckDuckGoHref = (href: string): string => {
  const normalized = href.replace(/&amp;/g, '&')
  const uddg = normalized.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    return decodeURIComponent(uddg[1])
  }
  return normalized.startsWith('//') ? `https:${normalized}` : normalized
}

const resultAnchor = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
const snippetTag = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/g

/** Parse the DuckDuckGo HTML results page into normalized results. */
const parseDuckDuckGoHtml = (html: string, numResults: number): SearchResult[] => {
  const snippets: string[] = []
  for (const match of html.matchAll(snippetTag)) {
    snippets.push(stripHtml(match[1]))
  }

  const results: SearchResult[] = []
  let i = 0
  for (const match of html.matchAll(resultAnchor)) {
    if (results.length >= numResults) {
      break
    }
    const url = decodeDuckDuckGoHref(match[1])
    const title = stripHtml(match[2])
    if (!url || !title) {
      i++
      continue
    }
    results.push({ url, title, snippet: snippets[i] ?? '', favicon: deriveFaviconUrl(url), image: null })
    i++
  }
  return results
}
