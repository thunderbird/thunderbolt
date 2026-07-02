/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolves the model the harness runs, branching on the requested provider:
 *
 *  - `anthropic` (default): looks the id up in Pi's built-in catalog. Pi's
 *    `@earendil-works/pi-ai/providers/all` is the only entry point that wires
 *    the providers (bare `createModels()` returns an empty collection); the
 *    wired anthropic provider resolves `ANTHROPIC_API_KEY` from the environment.
 *  - `openai-compat`: synthesizes an OpenAI-compatible model bound to a custom
 *    base URL + bearer key (see {@link buildOpenAiCompatModel}), so the CLI can
 *    run a non-Anthropic endpoint like Xiaomi MiMo.
 */

import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { buildOpenAiCompatModel } from './openai-compat-model.ts'
import type { ModelProvider } from './types.ts'

/** Default provider when none is specified. */
const ANTHROPIC: ModelProvider = 'anthropic'

/** Inputs for {@link resolveModel}: the model id plus the provider routing. */
export type ResolveModelOptions = {
  /** Model id to run (Anthropic catalog id, or upstream openai-compat id). */
  readonly model: string
  /** Backend to resolve against (defaults to `anthropic`). */
  readonly provider?: ModelProvider
  /** OpenAI-compatible base URL — required for `openai-compat`. */
  readonly baseUrl?: string
  /** Bearer api key — required for `openai-compat`. */
  readonly apiKey?: string
}

/** Resolves a single Anthropic model against Pi's wired built-in catalog. */
const resolveAnthropic = (requestedId: string): { models: Models; model: Model<Api> } => {
  const models = builtinModels()
  const model = models.getModel(ANTHROPIC, requestedId)
  if (!model) {
    throw new Error(`Unknown Anthropic model "${requestedId}".`)
  }
  return { models, model }
}

/** Resolves an OpenAI-compatible model, requiring the base URL + key the
 *  endpoint needs. */
const resolveOpenAiCompat = (opts: ResolveModelOptions): { models: Models; model: Model<Api> } => {
  if (!opts.baseUrl) {
    throw new Error('the openai-compat provider requires --base-url')
  }
  if (!opts.apiKey) {
    throw new Error(
      'the openai-compat provider requires an api key (pass --api-key or set THUNDERBOLT_OPENAI_COMPAT_KEY)',
    )
  }
  return buildOpenAiCompatModel({ modelId: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey })
}

/**
 * Builds the wired provider collection and resolves a single model, ready for
 * the harness.
 *
 * @param opts - the model id and provider routing (base URL / api key for openai-compat)
 * @returns the provider collection and the resolved model
 * @throws if an Anthropic id is unknown, or required openai-compat inputs are missing
 */
export const resolveModel = (opts: ResolveModelOptions): { models: Models; model: Model<Api> } =>
  opts.provider === 'openai-compat' ? resolveOpenAiCompat(opts) : resolveAnthropic(opts.model)
