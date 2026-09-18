/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { getTinfoilClient } from '@/ai/tinfoil-client'
import { fetch } from '@/lib/fetch'
import { http } from '@/lib/http'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { Model } from '@/types'
import { defaultModels } from '@shared/defaults/models'
import { catalogRequiresApiKey } from './model-policy'

export type AvailableModel = {
  id: string
  name?: string
  created?: number
  owned_by?: string
  supports_tools?: boolean
  supported_parameters?: string[]
}

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
const fetchAnthropicModels = async (apiKey: string): Promise<AvailableModel[]> => {
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
      fetch,
    })
    .json<{ data: Array<{ id: string; display_name?: string }> }>()
  // The endpoint doesn't report tool support; every listed Claude model supports tools.
  return response.data.map((model) => ({ id: model.id, name: model.display_name, supports_tools: true }))
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

/** The OpenAI-compatible models endpoint for a provider, or undefined when its
 *  prerequisite (API key, base URL) is missing so no request should be made. */
const resolveCatalogEndpoint = ({ provider, apiKey, url }: CatalogRequest): string | undefined => {
  if (provider === 'openai') {
    return apiKey ? 'https://api.openai.com/v1/models' : undefined
  }
  if (provider === 'openrouter') {
    return apiKey ? 'https://openrouter.ai/api/v1/models' : undefined
  }
  if (provider === 'custom' && url) {
    return `${normalizeOpenAiBaseUrl(url)}/models`
  }
  return undefined
}

/** Fetches a provider catalog only when explicitly requested by the caller. */
export const fetchModelsForProvider = async ({ provider, apiKey, url }: CatalogRequest): Promise<AvailableModel[]> => {
  if (provider === 'thunderbolt') {
    return thunderboltModelCatalog
  }
  if (provider === 'anthropic') {
    return apiKey ? fetchAnthropicModels(apiKey) : []
  }
  if (provider === 'tinfoil') {
    const client = await getTinfoilClient()
    const response = await http.get(`${client.getBaseURL()}models`, { fetch: client.fetch }).json<{
      data: Array<AvailableModel & { endpoints?: string[]; tool_calling?: boolean }>
    }>()
    return response.data
      .filter((model) => model.endpoints?.includes('/v1/chat/completions'))
      .map((model) => ({ ...model, supports_tools: model.tool_calling === true }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  const endpoint = resolveCatalogEndpoint({ provider, apiKey, url })
  if (!endpoint) {
    return []
  }

  const response = await http
    .get(endpoint, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, fetch })
    .json<{ data: AvailableModel[] }>()
  return response.data
    .map((model) => ({
      ...model,
      supports_tools:
        model.supports_tools === true ||
        model.supported_parameters?.some((parameter) => parameter === 'tools' || parameter === 'tool_choice') === true,
    }))
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
