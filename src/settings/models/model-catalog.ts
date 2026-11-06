/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { resolveOpenAiCompatConnection } from '@/ai/fetch'
import { getTinfoilClient } from '@/ai/tinfoil-client'
import { http } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { defaultModels } from '@shared/defaults/models'
import { catalogRequiresApiKey } from './model-policy'

export type AvailableModel = {
  id: string
  name?: string
  created?: number
  owned_by?: string
  /** Only the built-in Thunderbolt catalog sets this; other providers' tool
   *  support is learned by the connection test. */
  supports_tools?: boolean
  /** Whether the model accepts image input. Undefined when the provider doesn't say. */
  supports_images?: boolean
}

/** OpenRouter-style catalog rows report accepted inputs under `architecture`. */
type ModalityCatalogRow = AvailableModel & { architecture?: { input_modalities?: string[] } }

/** Read image support from `architecture.input_modalities`, leaving it unknown when absent. */
export const catalogRowSupportsImages = (row: ModalityCatalogRow): boolean | undefined =>
  row.architecture?.input_modalities ? row.architecture.input_modalities.includes('image') : undefined

export type CatalogRequest = {
  provider: Model['provider']
  apiKey?: string
  url?: string
}

/** Built-in catalog derived from the shipped default models; never fetched. */
export const thunderboltModelCatalog: AvailableModel[] = defaultModels
  .filter((model) => model.provider === 'thunderbolt')
  .map((model) => ({ id: model.model, name: model.name, supports_tools: model.toolUsage === 1 }))

/** Anthropic's models endpoint is not OpenAI-compatible: auth is `x-api-key` (not a
 *  bearer), a version header is mandatory, and rows carry `display_name`. Listing
 *  requires the user's key, so the catalog is key-gated like OpenAI/OpenRouter. */
const fetchAnthropicModels = async (apiKey: string, getProxyFetch: () => FetchFn): Promise<AvailableModel[]> => {
  const response = await http
    .get('https://api.anthropic.com/v1/models', {
      // The default page size is 20; 1000 is the documented maximum.
      searchParams: { limit: '1000' },
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Anthropic rejects browser (CORS) requests without this opt-in header.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      fetch: getProxyFetch(),
    })
    .json<{ data: Array<{ id: string; display_name?: string }> }>()
  return response.data.map((model) => ({ id: model.id, name: model.display_name }))
}

/** Debounce window shared by the add/edit forms before an auto catalog fetch,
 *  so credentials and URLs settle before they are sent anywhere. */
export const catalogDebounceMs = 500

/** True when a user-typed base URL is complete enough to receive a request
 *  (with its Authorization header). Guards the auto-fetch from firing at
 *  half-typed hosts mid-keystroke. Requires an http(s) scheme — bare
 *  `host:port` input parses as a URL with `host:` as its scheme. */
export const isFetchableCatalogUrl = (url: string | undefined): boolean => {
  if (!url) {
    return false
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** True when a catalog request carries everything its provider needs, so it is
 *  safe to send credentials anywhere. Single gate shared by the add/edit-form
 *  auto-fetch effects and the on-demand dropdown load. */
export const canFetchCatalog = ({ provider, apiKey, url }: CatalogRequest): boolean => {
  if (catalogRequiresApiKey(provider) && !apiKey) {
    return false
  }
  return provider !== 'custom' || isFetchableCatalogUrl(url)
}

/** Stable identity for the inputs that produced a catalog result. */
export const catalogRequestKey = ({ provider, apiKey, url }: CatalogRequest): string =>
  JSON.stringify([provider, apiKey ?? '', url ?? ''])

/** Fetches a provider catalog only when explicitly requested by the caller. */
export const fetchModelsForProvider = async (
  { provider, apiKey, url }: CatalogRequest,
  getProxyFetch: () => FetchFn,
): Promise<AvailableModel[]> => {
  if (provider === 'thunderbolt') {
    return thunderboltModelCatalog
  }
  if (provider === 'anthropic') {
    return apiKey ? fetchAnthropicModels(apiKey, getProxyFetch) : []
  }
  if (provider === 'tinfoil') {
    const client = await getTinfoilClient()
    const response = await http.get(`${client.getBaseURL()}models`, { fetch: client.fetch }).json<{
      data: Array<AvailableModel & { endpoints?: string[]; multimodal?: boolean }>
    }>()
    return response.data
      .filter((model) => model.endpoints?.includes('/v1/chat/completions'))
      .map((model) => ({ ...model, supports_images: model.multimodal }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  // Reuse chat's transport: web needs the proxy for hosts that don't answer preflights;
  // native follows the Cloud Proxy setting.
  const connection = resolveOpenAiCompatConnection(
    { provider, apiKey: apiKey ?? null, url: url ?? null },
    getProxyFetch,
  )
  if (!connection) {
    return []
  }

  // TrustedRouter's catalog is public; sending the key would add a CORS
  // preflight its API doesn't answer, and the keyless listing needs no gateway
  // attestation. It stays key-gated in the form only so the large catalog loads
  // once the user has committed to the provider.
  const isTrustedRouter = provider === 'trustedrouter'
  const response = await http
    .get(`${connection.baseURL}/models`, {
      headers: connection.apiKey && !isTrustedRouter ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      fetch: isTrustedRouter ? getProxyFetch() : connection.fetch,
    })
    .json<{ data: ModalityCatalogRow[] }>()
  return response.data
    .map((model) => ({ ...model, supports_images: catalogRowSupportsImages(model) }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Maps a catalog-fetch failure to a user-facing message (network, HTTP status,
 * or generic). Takes `i18n` because one branch interpolates the HTTP status, so
 * the descriptors can't all live at module scope.
 */
export const describeModelFetchError = (i18n: I18n, error: unknown): string => {
  if (error instanceof TypeError) {
    return i18n._(msg`Network request failed (the browser blocked the request or the server is unreachable).`)
  }
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (error as { response?: Response }).response
    if (!response) {
      return i18n._(msg`Server responded with an unknown error.`)
    }
    const status = response.status
    const statusText = response.statusText
    return i18n._(msg`Server responded with status ${status} ${statusText}`)
  }
  return error instanceof Error && error.message ? error.message : i18n._(msg`Failed to load models`)
}
