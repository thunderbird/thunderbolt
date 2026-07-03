/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deriveFaviconUrl } from '../../../shared/url'
import type { ProviderType } from '../../../shared/providers'
import { buildSearchRequest, type ProviderRequestContext } from './requests'

/**
 * Normalized web-search result. A superset of the fields the app renders (title,
 * url, favicon, image) plus a `snippet` for the providers that return one, so
 * the model gets useful text without a follow-up fetch. Every `search`-capable
 * provider's response is parsed into this shape.
 */
export type SearchResult = {
  title: string
  url: string
  snippet: string
  favicon: string | null
  image: string | null
}

/** Read a bounded slice of a response body for inline error messages. */
const safeBodyText = async (res: Response): Promise<string> => {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}

/** Build a normalized result, deriving a favicon from the origin when absent. */
const toResult = (
  url: string,
  title: string | undefined,
  snippet: string | undefined,
  extra: { favicon?: string | null; image?: string | null } = {},
): SearchResult => ({
  url,
  title: title?.trim() || url,
  snippet: snippet?.trim() ?? '',
  favicon: extra.favicon ?? deriveFaviconUrl(url),
  image: extra.image ?? null,
})

type ExaResponse = {
  results?: Array<{ title?: string; url: string; text?: string; favicon?: string; image?: string }>
}
type BraveResponse = { web?: { results?: Array<{ title?: string; url: string; description?: string }> } }
type SerpApiResponse = { organic_results?: Array<{ title?: string; link: string; snippet?: string }> }
type SearxngResponse = { results?: Array<{ title?: string; url: string; content?: string }> }

/** Parse Exa `POST /search` — `results[].{title,url,text}`. */
const parseExa = (json: ExaResponse): SearchResult[] =>
  (json.results ?? []).map((r) => toResult(r.url, r.title, r.text, { favicon: r.favicon, image: r.image }))

/** Parse Brave `GET /web/search` — `web.results[].{title,url,description}`. */
const parseBrave = (json: BraveResponse): SearchResult[] =>
  (json.web?.results ?? []).map((r) => toResult(r.url, r.title, r.description))

/** Parse SerpAPI `GET /search.json` — `organic_results[].{title,link,snippet}`. */
const parseSerpApi = (json: SerpApiResponse): SearchResult[] =>
  (json.organic_results ?? []).map((r) => toResult(r.link, r.title, r.snippet))

/** Parse SearXNG `GET /search` — `results[].{title,url,content}`. */
const parseSearxng = (json: SearxngResponse): SearchResult[] =>
  (json.results ?? []).map((r) => toResult(r.url, r.title, r.content))

/**
 * Execute a web search against a JSON `search`-capable provider and normalize the
 * response. Handles exa, brave, serpapi and searxng. DuckDuckGo is keyless HTML
 * and is handled by `freeSearchDuckDuckGo` in `./free-search`, not here.
 */
export const executeProviderSearch = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  query: string,
  fetchFn: typeof fetch,
  numResults = 10,
): Promise<SearchResult[]> => {
  const { url, init } = buildSearchRequest(type, ctx, { query, numResults })
  const res = await fetchFn(url, init)
  if (!res.ok) {
    throw new Error(`Search failed (${res.status}): ${await safeBodyText(res)}`)
  }

  // A misconfigured SearXNG (JSON output disabled) returns an HTML page — surface
  // a clear, actionable error rather than letting `res.json()` throw a parse error.
  if (type === 'searxng' && !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error('SearXNG returned non-JSON. Enable JSON output (formats: [json]) on your instance.')
  }

  const json = await res.json()
  switch (type) {
    case 'exa':
      return parseExa(json as ExaResponse)
    case 'brave':
      return parseBrave(json as BraveResponse)
    case 'serpapi':
      return parseSerpApi(json as SerpApiResponse)
    case 'searxng':
      return parseSearxng(json as SearxngResponse)
    default:
      throw new Error(`Provider "${type}" is not a supported JSON search provider`)
  }
}
