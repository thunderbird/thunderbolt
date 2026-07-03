/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  authHeaderName,
  formatAuthHeaderValue,
  getProviderDefinition,
  type ProviderDefinition,
  type ProviderType,
} from '../../../shared/providers'

/** A fully-resolved HTTP request (URL + init) ready to hand to any `fetch`. */
export type BuiltRequest = { url: string; init: RequestInit }

export type ProviderRequestContext = {
  /** Credential (api key / bearer token). Absent for keyless providers. */
  apiKey?: string
  /** Base URL override (for `url`-type providers, or a user-set base). */
  baseUrl?: string
}

/** Resolve the effective base URL: explicit override → catalog default. */
const resolveBaseUrl = (def: ProviderDefinition, ctx: ProviderRequestContext): string => {
  const base = ctx.baseUrl?.trim() || def.defaultBaseUrl
  if (!base) {
    throw new Error(`Provider "${def.type}" requires a base URL`)
  }
  return base.replace(/\/+$/, '')
}

/** Absolute endpoint if it already looks absolute, else join to the base URL. */
const resolveEndpoint = (def: ProviderDefinition, ctx: ProviderRequestContext, path: string): string =>
  /^https?:\/\//.test(path) ? path : `${resolveBaseUrl(def, ctx)}${path}`

/** Build the auth headers for a header-based scheme. */
const authHeaders = (def: ProviderDefinition, ctx: ProviderRequestContext): Record<string, string> => {
  const headers: Record<string, string> = { ...(def.auth.extraHeaders ?? {}) }
  if (
    ctx.apiKey &&
    (def.auth.scheme === 'bearer' || def.auth.scheme === 'x-api-key' || def.auth.scheme === 'x-subscription-token')
  ) {
    headers[authHeaderName(def)] = formatAuthHeaderValue(def, ctx.apiKey)
  }
  return headers
}

/** GET the provider's model list (OpenAI-compatible `/models`, Anthropic `/models`). */
export const buildModelsListRequest = (type: ProviderType, ctx: ProviderRequestContext): BuiltRequest => {
  const def = getProviderDefinition(type)
  if (!def.models) {
    throw new Error(`Provider "${type}" has no models capability`)
  }
  return {
    url: resolveEndpoint(def, ctx, def.models.listPath),
    init: { method: 'GET', headers: authHeaders(def, ctx) },
  }
}

export type ChatCompletionParams = {
  model: string
  prompt: string
  maxTokens?: number
}

/**
 * Build a minimal chat-completion request for the connection test. OpenAI-shaped
 * for every provider except Anthropic, which uses its `/messages` schema.
 */
export const buildChatCompletionRequest = (
  type: ProviderType,
  ctx: ProviderRequestContext,
  params: ChatCompletionParams,
): BuiltRequest => {
  const def = getProviderDefinition(type)
  if (!def.models) {
    throw new Error(`Provider "${type}" has no models capability`)
  }
  const url = resolveEndpoint(def, ctx, def.models.chatCompletionsPath)
  const headers = { 'content-type': 'application/json', ...authHeaders(def, ctx) }
  // Both OpenAI-compatible `/chat/completions` and Anthropic `/messages` accept
  // this minimal shape (single user turn + `max_tokens`), so one body serves the
  // connection test for every model provider.
  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 1,
        messages: [{ role: 'user', content: params.prompt }],
      }),
    },
  }
}

export type SearchParams = {
  query: string
  numResults?: number
}

/** Build a web-search request for a `search`-capable provider. */
export const buildSearchRequest = (
  type: ProviderType,
  ctx: ProviderRequestContext,
  params: SearchParams,
): BuiltRequest => {
  const def = getProviderDefinition(type)
  if (!def.search) {
    throw new Error(`Provider "${type}" has no search capability`)
  }
  const { endpoint, method, queryParam } = def.search
  const numResults = params.numResults ?? 5

  if (method === 'POST') {
    return {
      url: resolveEndpoint(def, ctx, endpoint),
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(def, ctx) },
        body: JSON.stringify({ [queryParam]: params.query, numResults }),
      },
    }
  }

  // GET — assemble query string, adding provider-specific params.
  const url = new URL(resolveEndpoint(def, ctx, endpoint))
  url.searchParams.set(queryParam, params.query)
  if (def.auth.scheme === 'query' && def.auth.queryParam && ctx.apiKey) {
    url.searchParams.set(def.auth.queryParam, ctx.apiKey)
  }
  if (type === 'serpapi') {
    url.searchParams.set('engine', 'google')
    url.searchParams.set('num', String(numResults))
  }
  if (type === 'brave') {
    url.searchParams.set('count', String(numResults))
  }
  if (type === 'searxng') {
    url.searchParams.set('format', 'json')
  }
  return { url: url.toString(), init: { method: 'GET', headers: authHeaders(def, ctx) } }
}
