/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderDefinition, type ProviderType } from '../../../shared/providers'
import {
  buildChatCompletionRequest,
  buildModelsListRequest,
  buildSearchRequest,
  type ProviderRequestContext,
} from './requests'

export type ValidationResult = { ok: true } | { ok: false; error: string }

/** A model exposed by a provider's catalog (`/models`). */
export type CatalogModel = { id: string; name?: string; contextWindow?: number }

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const safeBodyText = async (res: Response): Promise<string> => {
  try {
    const text = await res.text()
    return text.slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * Fetch and parse a provider's model catalog. Handles the OpenAI/Anthropic/
 * OpenRouter/Ollama `{ data: [{ id, name? }] }` shape and the Ollama-native
 * `{ models: [{ name }] }` fallback.
 */
export const listProviderModels = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  fetchFn: typeof fetch,
): Promise<CatalogModel[]> => {
  const { url, init } = buildModelsListRequest(type, ctx)
  const res = await fetchFn(url, init)
  if (!res.ok) {
    throw new Error(`Model list failed (${res.status}): ${await safeBodyText(res)}`)
  }
  const json = (await res.json()) as {
    data?: Array<{ id: string; name?: string; context_length?: number }>
    models?: Array<{ name: string }>
  }
  if (Array.isArray(json.data)) {
    return json.data.map((m) => ({ id: m.id, name: m.name, contextWindow: m.context_length }))
  }
  if (Array.isArray(json.models)) {
    return json.models.map((m) => ({ id: m.name, name: m.name }))
  }
  return []
}

/**
 * Validate a `models` connection: list `/models`, then a 1-token completion
 * against the chosen default (or the first listed model). Surfaces the upstream
 * error inline.
 */
export const validateModelsCapability = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  fetchFn: typeof fetch,
  model?: string,
): Promise<ValidationResult> => {
  try {
    const models = await listProviderModels(type, ctx, fetchFn)
    if (models.length === 0) {
      return { ok: false, error: 'Provider returned no models.' }
    }
    const testModel = model ?? models[0].id
    const { url, init } = buildChatCompletionRequest(type, ctx, { model: testModel, prompt: 'Hi', maxTokens: 1 })
    const res = await fetchFn(url, init)
    if (!res.ok) {
      return { ok: false, error: `Test message failed (${res.status}): ${await safeBodyText(res)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

/**
 * Validate a `search` connection with one query. Detects the common SearXNG
 * misconfiguration where JSON output is disabled and HTML comes back (§14).
 */
export const validateSearchCapability = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  fetchFn: typeof fetch,
  query = 'thunderbird email',
): Promise<ValidationResult> => {
  const def = getProviderDefinition(type)
  try {
    const { url, init } = buildSearchRequest(type, ctx, { query, numResults: 1 })
    const res = await fetchFn(url, init)
    if (!res.ok) {
      return { ok: false, error: `Search failed (${res.status}): ${await safeBodyText(res)}` }
    }
    if (def.type === 'searxng') {
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('json')) {
        return {
          ok: false,
          error: 'SearXNG returned non-JSON. Enable JSON output (formats: [json]) on your instance.',
        }
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}
