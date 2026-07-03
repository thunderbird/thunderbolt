/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Provider catalog — static metadata per provider *type*. Ships with the app
 * (not a table). A Provider is a connected account at an infra company that
 * advertises one or more capabilities. Most offer one; some (Tinfoil) offer
 * both. See spec.md §2.1 and spec-standalone §3 for the auth matrix.
 */

/** What a provider CAN do. Extensible: 'embeddings', 'tts', … */
export type ProviderCapability = 'models' | 'search'

/** How the user connects an account. `oauth-paste` intentionally dropped (no v1 provider uses it). */
export type ConnectionType = 'oauth-pkce' | 'api-key' | 'url'

/** How a credential is presented to the provider on each request. */
export type AuthScheme = 'bearer' | 'x-api-key' | 'x-subscription-token' | 'query' | 'none'

export type ProviderType =
  | 'openrouter'
  | 'tinfoil'
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'custom'
  | 'exa'
  | 'brave'
  | 'serpapi'
  | 'searxng'
  | 'duckduckgo'

/** OpenAI-compatible endpoint paths for a `models`-capable provider. */
export type ModelsEndpoints = {
  /** Relative to baseUrl. GET → list of models. */
  listPath: string
  /** Relative to baseUrl. POST → chat completion (used by the 1-token test). */
  chatCompletionsPath: string
  /**
   * The `provider` enum value written to `modelsTable.provider` for models from
   * this provider, so the existing `src/ai/fetch.ts` dispatch keeps working.
   * Ollama/custom → 'custom' (OpenAI-compatible via base URL).
   */
  modelProvider: 'openai' | 'custom' | 'openrouter' | 'anthropic' | 'tinfoil'
}

/** Search endpoint metadata for a `search`-capable provider. */
export type SearchEndpoints = {
  /** Absolute URL, or relative to a user-supplied baseUrl for `url` providers. */
  endpoint: string
  method: 'GET' | 'POST'
  /** Query parameter (GET/query-auth) or JSON body key (POST) carrying the query. */
  queryParam: string
}

export type ProviderDefinition = {
  type: ProviderType
  name: string
  /** What it CAN do — the "one company, many capabilities" thesis lives here. */
  capabilities: ProviderCapability[]
  connectionType: ConnectionType
  /** Default base URL for `url`-type providers (Ollama localhost, etc.). */
  defaultBaseUrl?: string
  /** `url`-type providers require the user to supply/confirm a base URL. */
  requiresBaseUrl?: boolean
  /** Connection deferred (Tinfoil) — show "coming soon", don't offer connect. */
  comingSoon?: boolean
  /** Keyless free provider (DuckDuckGo) — no connection row/secret needed. */
  free?: boolean
  auth: {
    scheme: AuthScheme
    /** Header name for header-based schemes (default per scheme). */
    header?: string
    /** Query-param name for `query` scheme (e.g. SerpAPI `api_key`). */
    queryParam?: string
    /** Extra static headers required by the provider (e.g. anthropic-version). */
    extraHeaders?: Record<string, string>
  }
  models?: ModelsEndpoints
  search?: SearchEndpoints
  /** OAuth PKCE endpoints for `oauth-pkce` providers. */
  oauth?: {
    authorizeUrl: string
    /** Exchanges { code, code_verifier } → { key }. */
    tokenUrl: string
  }
}

export const PROVIDER_CATALOG: Record<ProviderType, ProviderDefinition> = {
  openrouter: {
    type: 'openrouter',
    name: 'OpenRouter',
    capabilities: ['models'],
    connectionType: 'oauth-pkce',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    auth: { scheme: 'bearer' },
    models: { listPath: '/models', chatCompletionsPath: '/chat/completions', modelProvider: 'openrouter' },
    oauth: {
      authorizeUrl: 'https://openrouter.ai/auth',
      tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
    },
  },
  tinfoil: {
    type: 'tinfoil',
    name: 'Tinfoil',
    capabilities: ['models', 'search'],
    connectionType: 'api-key',
    defaultBaseUrl: 'https://inference.tinfoil.sh/v1',
    comingSoon: true,
    auth: { scheme: 'bearer' },
    models: { listPath: '/models', chatCompletionsPath: '/chat/completions', modelProvider: 'tinfoil' },
    search: { endpoint: 'https://inference.tinfoil.sh/search', method: 'POST', queryParam: 'query' },
  },
  anthropic: {
    type: 'anthropic',
    name: 'Anthropic',
    capabilities: ['models'],
    connectionType: 'api-key',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    auth: { scheme: 'x-api-key', extraHeaders: { 'anthropic-version': '2023-06-01' } },
    // Anthropic is not OpenAI-compatible for chat; the AI SDK's createAnthropic
    // handles routing. listPath is used only by the connection test.
    models: { listPath: '/models', chatCompletionsPath: '/messages', modelProvider: 'anthropic' },
  },
  openai: {
    type: 'openai',
    name: 'OpenAI',
    capabilities: ['models'],
    connectionType: 'api-key',
    defaultBaseUrl: 'https://api.openai.com/v1',
    auth: { scheme: 'bearer' },
    models: { listPath: '/models', chatCompletionsPath: '/chat/completions', modelProvider: 'openai' },
  },
  ollama: {
    type: 'ollama',
    name: 'Ollama',
    capabilities: ['models'],
    connectionType: 'url',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresBaseUrl: true,
    auth: { scheme: 'bearer' }, // optional; local default needs none
    models: { listPath: '/models', chatCompletionsPath: '/chat/completions', modelProvider: 'custom' },
  },
  custom: {
    type: 'custom',
    name: 'Custom (OpenAI-compatible)',
    capabilities: ['models'],
    connectionType: 'url',
    requiresBaseUrl: true,
    auth: { scheme: 'bearer' },
    models: { listPath: '/models', chatCompletionsPath: '/chat/completions', modelProvider: 'custom' },
  },
  exa: {
    type: 'exa',
    name: 'Exa',
    capabilities: ['search'],
    connectionType: 'api-key',
    defaultBaseUrl: 'https://api.exa.ai',
    auth: { scheme: 'x-api-key' },
    search: { endpoint: 'https://api.exa.ai/search', method: 'POST', queryParam: 'query' },
  },
  brave: {
    type: 'brave',
    name: 'Brave Search',
    capabilities: ['search'],
    connectionType: 'api-key',
    defaultBaseUrl: 'https://api.search.brave.com/res/v1',
    auth: { scheme: 'x-subscription-token' },
    search: { endpoint: 'https://api.search.brave.com/res/v1/web/search', method: 'GET', queryParam: 'q' },
  },
  serpapi: {
    type: 'serpapi',
    name: 'SerpAPI',
    capabilities: ['search'],
    connectionType: 'api-key',
    defaultBaseUrl: 'https://serpapi.com',
    auth: { scheme: 'query', queryParam: 'api_key' },
    search: { endpoint: 'https://serpapi.com/search.json', method: 'GET', queryParam: 'q' },
  },
  searxng: {
    type: 'searxng',
    name: 'SearXNG',
    capabilities: ['search'],
    connectionType: 'url',
    requiresBaseUrl: true,
    auth: { scheme: 'none' },
    // endpoint is relative to the user-supplied baseUrl. JSON output must be
    // enabled by the operator — surface a clear error if HTML comes back.
    search: { endpoint: '/search', method: 'GET', queryParam: 'q' },
  },
  duckduckgo: {
    type: 'duckduckgo',
    name: 'DuckDuckGo (free)',
    capabilities: ['search'],
    connectionType: 'url',
    free: true,
    auth: { scheme: 'none' },
    search: { endpoint: 'https://html.duckduckgo.com/html/', method: 'GET', queryParam: 'q' },
  },
}

/** Default display/selection order for model providers (spec-standalone §2). */
export const MODEL_PROVIDER_ORDER: ProviderType[] = ['openrouter', 'tinfoil', 'anthropic', 'openai', 'ollama', 'custom']

/** Default display/selection order for search providers. */
export const SEARCH_PROVIDER_ORDER: ProviderType[] = ['exa', 'brave', 'serpapi', 'searxng', 'duckduckgo']

export const getProviderDefinition = (type: ProviderType): ProviderDefinition => PROVIDER_CATALOG[type]

/** All catalog entries offering a given capability, in catalog order. */
export const providersWithCapability = (capability: ProviderCapability): ProviderDefinition[] =>
  Object.values(PROVIDER_CATALOG).filter((p) => p.capabilities.includes(capability))

/** True when connecting this provider requires the user to supply a credential. */
export const providerNeedsCredential = (type: ProviderType): boolean => {
  const def = PROVIDER_CATALOG[type]
  return !def.free && def.auth.scheme !== 'none'
}

/** Default header name for a header-based auth scheme. */
export const authHeaderName = (def: ProviderDefinition): string => {
  if (def.auth.header) return def.auth.header
  switch (def.auth.scheme) {
    case 'bearer':
      return 'Authorization'
    case 'x-api-key':
      return 'x-api-key'
    case 'x-subscription-token':
      return 'X-Subscription-Token'
    default:
      return 'Authorization'
  }
}

/** Format a credential value for its auth scheme (Bearer prefix, raw key, etc.). */
export const formatAuthHeaderValue = (def: ProviderDefinition, apiKey: string): string =>
  def.auth.scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey
