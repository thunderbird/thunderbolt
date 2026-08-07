/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The runner's Pro web tools (`search`, `fetch_content`): the same backend
 * endpoints the browser harness wraps, called with the session's own bearer.
 *
 * These tools are why Pro no longer pins a thread to the device: nothing in
 * them touches device state, so serving them here (with identical names,
 * descriptions, and source labeling — see `shared/tools/pro-tools-contract.ts`)
 * keeps a runner-placed turn's capabilities equal to a local one's.
 *
 * Failures throw: the agent loop converts a thrown error into an error tool
 * result whose message the model reads — the same experience the browser
 * harness produces by throwing from its `execute`.
 */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  deriveSiteName,
  fetchContentMaxLengthDescription,
  fetchContentToolDescription,
  fetchContentToolName,
  fetchContentUrlDescription,
  formatSourceLabel,
  searchMaxResultsDescription,
  searchQueryDescription,
  searchToolDescription,
  searchToolName,
  sourceRegistryCap,
  type FetchContentData,
  type LinkPreviewData,
  type SearchResultData,
  type SourceMetadata,
} from '../../shared/tools/pro-tools-contract.ts'
import type { ToolHost } from './render-html-tool.ts'

/** Bound on one backend tool round-trip — mirrors the browser harness. */
const requestTimeoutMs = 10_000

/**
 * Per-session source numbering: every distinct URL a turn cites gets a stable
 * 1-based index, deduplicated across `search` and `fetch_content` for the
 * session's lifetime so `[N]` citations never point at two different pages.
 * Past {@link sourceRegistryCap} stored URLs, indexes keep advancing without
 * being stored — matching the browser harness's registry semantics.
 */
export type SourceRegistry = {
  /** The index for a URL: the stored one when seen before, a fresh one otherwise. */
  claim: (url: string) => number
}

/** Create the per-session {@link SourceRegistry}. */
export const createSourceRegistry = (): SourceRegistry => {
  const indexByUrl = new Map<string, number>()
  let nextIndex = 1
  return {
    claim: (url) => {
      const existing = indexByUrl.get(url)
      if (existing !== undefined) {
        return existing
      }
      const index = nextIndex++
      if (indexByUrl.size < sourceRegistryCap) {
        indexByUrl.set(url, index)
      }
      return index
    },
  }
}

export type ProToolsDeps = {
  /** Backend origin, no trailing slash. */
  readonly backendUrl: string
  /** Supplier of the session's current bearer — model requests and tool
   *  requests must ride the same credential. */
  readonly readBearer: () => string
  /** Session-lived source numbering shared by both tools. */
  readonly sources: SourceRegistry
  /** Injectable fetch for tests. */
  readonly fetchFn?: typeof fetch
}

const searchSchema = Type.Object({
  query: Type.String({ description: searchQueryDescription }),
  max_results: Type.Number({ description: searchMaxResultsDescription }),
})

const fetchContentSchema = Type.Object({
  url: Type.String({ description: fetchContentUrlDescription }),
  max_length: Type.Optional(Type.Number({ description: fetchContentMaxLengthDescription })),
})

const backendRequest = async (deps: ProToolsDeps, path: string, init: RequestInit): Promise<Response> => {
  const fetchFn = deps.fetchFn ?? fetch
  return fetchFn(`${deps.backendUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${deps.readBearer()}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
}

const searchBackend = async (deps: ProToolsDeps, query: string, maxResults: number): Promise<SearchResultData[]> => {
  const params = new URLSearchParams({ q: query, limit: String(maxResults) })
  const response = await backendRequest(deps, `/v1/search?${params}`, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`Search failed: backend responded ${response.status}`)
  }
  const body = (await response.json()) as { results: SearchResultData[] }
  return body.results
}

const fetchContentBackend = async (
  deps: ProToolsDeps,
  url: string,
  maxLength: number | undefined,
): Promise<FetchContentData> => {
  const response = await backendRequest(deps, '/v1/pro/fetch-content', {
    method: 'POST',
    body: JSON.stringify({ url, ...(maxLength !== undefined && { max_length: maxLength }) }),
  })
  if (!response.ok) {
    throw new Error(`Fetch content failed: backend responded ${response.status}`)
  }
  const body = (await response.json()) as { data: FetchContentData; success: boolean; error?: string }
  if (!body.success) {
    throw new Error(body.error || 'Fetch content failed')
  }
  return body.data
}

const fetchLinkPreviewBackend = async (deps: ProToolsDeps, url: string): Promise<LinkPreviewData | null> => {
  const response = await backendRequest(deps, '/v1/preview', { method: 'POST', body: JSON.stringify({ url }) })
  if (!response.ok) {
    return null
  }
  return (await response.json()) as LinkPreviewData
}

/**
 * Wrap structured tool data as the text content the model reads, carrying the
 * call's citation-registry entries alongside. The whole result object travels
 * to the client as the ACP tool call's `rawOutput`, where `sources` is what
 * rebuilds the `[N]` citation chips for runner turns (the browser harness gets
 * them via a locally accumulated collector instead).
 */
const asTextResult = (payload: unknown, sources: SourceMetadata[]) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  details: {},
  sources,
})

const createSearchTool = (deps: ProToolsDeps): AgentTool<typeof searchSchema> => ({
  name: searchToolName,
  label: 'search the web',
  description: searchToolDescription,
  parameters: searchSchema,
  execute: async (_toolCallId, input) => {
    const results = await searchBackend(deps, input.query, input.max_results)
    const sources: SourceMetadata[] = []
    const labeled = results.map((result) => {
      const sourceIndex = deps.sources.claim(result.pageUrl)
      sources.push({
        index: sourceIndex,
        url: result.pageUrl,
        title: result.title,
        image: result.previewImageUrl,
        favicon: result.faviconUrl,
        siteName: deriveSiteName(result.pageUrl),
        author: null,
        publishedDate: null,
        toolName: searchToolName,
      })
      return { sourceLabel: formatSourceLabel(sourceIndex), sourceIndex, ...result }
    })
    return asTextResult(labeled, sources)
  },
})

const createFetchContentTool = (deps: ProToolsDeps): AgentTool<typeof fetchContentSchema> => ({
  name: fetchContentToolName,
  label: 'fetch a webpage',
  description: fetchContentToolDescription,
  parameters: fetchContentSchema,
  execute: async (_toolCallId, input) => {
    // Preview is best-effort enrichment (og:site_name and preview image); the
    // page content is the answer, so a preview failure must not fail the tool.
    const [result, preview] = await Promise.all([
      fetchContentBackend(deps, input.url, input.max_length),
      fetchLinkPreviewBackend(deps, input.url).catch(() => null),
    ])
    if (!result) {
      return asTextResult(result, [])
    }
    const sourceIndex = deps.sources.claim(result.url)
    const image = preview?.previewImageUrl ?? result.image
    return asTextResult(
      {
        sourceLabel: formatSourceLabel(sourceIndex),
        sourceIndex,
        siteName: preview?.siteName ?? null,
        ...result,
        image,
      },
      [
        {
          index: sourceIndex,
          url: result.url,
          title: result.title ?? result.url,
          description: result.text?.slice(0, 200),
          image,
          favicon: result.favicon,
          siteName: preview?.siteName || deriveSiteName(result.url),
          author: result.author,
          publishedDate: result.published_date,
          toolName: fetchContentToolName,
        },
      ],
    )
  },
})

/** Build both Pro web tools for one session. */
export const createProTools = (deps: ProToolsDeps): AgentTool[] => [
  createSearchTool(deps) as AgentTool,
  createFetchContentTool(deps) as AgentTool,
]

/** Append the Pro web tools to a freshly built harness's toolset and mark
 *  them active — same registration shape as `registerRenderHtmlTool`. */
export const registerProTools = async (host: ToolHost, deps: ProToolsDeps): Promise<void> => {
  const tools = [...host.getTools(), ...createProTools(deps)]
  await host.setTools(
    tools,
    tools.map((tool) => tool.name),
  )
}
