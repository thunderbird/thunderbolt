/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getTinfoilClient } from '@/ai/fetch'
import { fetch } from '@/lib/fetch'
import { http } from '@/lib/http'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { Model } from '@/types'
import { defaultModels } from '@shared/defaults/models'

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

// Anthropic's /v1/models endpoint requires an API key even to list, and this
// catalog must render before the user has entered one — so the list is
// maintained by hand. Update it from https://docs.anthropic.com/en/docs/about-claude/models
// when Anthropic ships new models.
const anthropicModelCatalog: AvailableModel[] = [
  { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', supports_tools: true },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', supports_tools: true },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', supports_tools: true },
  { id: 'claude-3-7-sonnet-20250219', name: 'Claude Sonnet 3.7', supports_tools: true },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude Sonnet 3.5', supports_tools: true },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude Haiku 3.5', supports_tools: true },
  { id: 'claude-3-5-sonnet-20240620', name: 'Claude Sonnet 3.5 (Old)', supports_tools: true },
  { id: 'claude-3-haiku-20240307', name: 'Claude Haiku 3', supports_tools: true },
  { id: 'claude-3-opus-20240229', name: 'Claude Opus 3', supports_tools: true },
]

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
    return anthropicModelCatalog
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

/** Maps a catalog-fetch failure to a user-facing message (network, HTTP status, or generic). */
export const describeModelFetchError = (error: unknown): string => {
  if (error instanceof TypeError) {
    return 'Network request failed (the browser blocked the request or the server is unreachable).'
  }
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (error as { response?: Response }).response
    return response
      ? `Server responded with status ${response.status} ${response.statusText}`
      : 'Server responded with an unknown error.'
  }
  return error instanceof Error && error.message ? error.message : 'Failed to load models'
}
