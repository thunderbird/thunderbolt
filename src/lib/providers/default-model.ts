/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderDefinition, type ProviderType } from '../../../shared/providers'
import { buildChatCompletionRequest, type ProviderRequestContext } from './requests'
import { listProviderModels, type CatalogModel } from './validate'

/**
 * Default-model selection (spec-standalone §9). A curated per-provider
 * preference list is intersected with the provider's live catalog; each
 * candidate gets a 1-token test message and the first that passes becomes the
 * default. If none of the preferred models pass (or the provider has no curated
 * list — Ollama/custom), we fall back to the first listed model WITHOUT probing
 * the whole catalog (which can be thousands of models).
 */
const modelPreferences: Partial<Record<ProviderType, string[]>> = {
  openrouter: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'anthropic/claude-3-5-sonnet-20241022'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-latest'],
  tinfoil: [],
  ollama: [],
  custom: [],
}

/** Run a 1-token completion against one model; true iff it responds OK. */
const testModel = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  fetchFn: typeof fetch,
  modelId: string,
): Promise<boolean> => {
  const { url, init } = buildChatCompletionRequest(type, ctx, { model: modelId, prompt: 'Hi', maxTokens: 1 })
  try {
    const res = await fetchFn(url, init)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Pick a sensible default model for a freshly-connected provider. Returns the
 * chosen catalog entry, or null when the provider exposes no models.
 */
export const selectDefaultModel = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  fetchFn: typeof fetch,
): Promise<CatalogModel | null> => {
  // getProviderDefinition throws for unknown types — surface early.
  getProviderDefinition(type)

  const catalog = await listProviderModels(type, ctx, fetchFn)
  if (catalog.length === 0) {
    return null
  }
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const preferred = (modelPreferences[type] ?? []).filter((id) => byId.has(id))

  for (const id of preferred) {
    if (await testModel(type, ctx, fetchFn, id)) {
      return byId.get(id) ?? null
    }
  }
  // Fallback: first listed model (no full-catalog probing).
  return catalog[0]
}
