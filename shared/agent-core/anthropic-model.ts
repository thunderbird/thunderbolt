/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Builds a Pi-compatible Anthropic model whose HTTP goes through an injected
 * `fetch`. This is the seam the in-browser embed needs: the app must route LLM
 * calls through its CORS proxy via a custom fetch, but Pi's built-in anthropic
 * provider constructs its `@anthropic-ai/sdk` client without a `fetch` hook.
 *
 * The `@anthropic-ai/sdk` constructor *does* accept `fetch`, and Pi's
 * `anthropic-messages` API exposes a public `client?: Anthropic` option that
 * skips internal client construction. So we build the SDK client ourselves with
 * the injected fetch and hand it to Pi via that option — no fork of Pi.
 *
 * The one wrinkle: the harness drives streaming through `Models.streamSimple`,
 * and Pi's `streamSimple` rebuilds its options via `buildBaseOptions`, which
 * drops the `client` field. Only the full `stream` entry point honors `client`.
 * So this module re-implements Pi's thin simple→full options bridge (reusing
 * Pi's own exported `buildBaseOptions`/`adjustMaxTokensForThinking`) and injects
 * the pre-built client into the full `stream` call.
 *
 * Header fidelity note: handing Pi a pre-built client bypasses its per-request
 * header logic. We restore the two static headers that matter for the browser
 * (`accept`, `anthropic-dangerous-direct-browser-access`). The only per-request
 * header lost for tool-using runs is the `fine-grained-tool-streaming` beta
 * (incremental tool-arg streaming — UX only, not correctness). The interleaved-
 * thinking beta is irrelevant here: every adaptive model (e.g. claude-opus-4-8)
 * has it built in and Pi skips that header for them anyway.
 */

import Anthropic from '@anthropic-ai/sdk'
import {
  type Api,
  type AnthropicEffort,
  type AnthropicOptions,
  type Context,
  type Model,
  type Models,
  type ProviderStreams,
  type SimpleStreamOptions,
  type ThinkingLevel,
  createModels,
  createProvider,
  envApiKeyAuth,
  hasApi,
} from '@earendil-works/pi-ai'
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages'
import { adjustMaxTokensForThinking, buildBaseOptions } from '@earendil-works/pi-ai/api/simple-options'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

/** Provider id of the resolved model; matches Pi's built-in anthropic provider. */
const PROVIDER = 'anthropic'
const API = 'anthropic-messages'

/** Valid adaptive-thinking effort levels, used to narrow catalog overrides. */
const EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Minimal fetch shape every request is routed through. The app passes its proxy
 * fetch (`FetchFn` from `src/lib/proxy-fetch.ts`, which additionally carries a
 * `preconnect` method); a bare global fetch also satisfies this. Declared
 * structurally — rather than as `typeof globalThis.fetch` — to dodge the
 * Bun-vs-DOM `preconnect` signature clash that `typeof fetch` triggers when both
 * type roots are loaded (the same reason `proxy-fetch.ts` pins its own `FetchFn`
 * alias). Assignable to `@anthropic-ai/sdk`'s `Fetch` option, and every proxy
 * fetch is assignable to it.
 */
export type AgentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Inputs for {@link buildAnthropicModel}. */
export type BuildAnthropicModelOptions = {
  /** Anthropic API key (used to build the SDK client; HTTP still flows through `fetch`). */
  readonly apiKey: string
  /** The fetch implementation every request is routed through (e.g. the app's proxy fetch). */
  readonly fetch: AgentFetch
  /** Anthropic model id to resolve, e.g. `claude-opus-4-8`. */
  readonly modelId: string
}

/**
 * Whether Pi's built-in Anthropic catalog can resolve `modelId` as an
 * anthropic-messages model. The adapter's routing gate calls this so a model id
 * Pi doesn't know (e.g. a brand-new claude the catalog lacks) falls back to the
 * legacy pipeline instead of crashing the chat. Cheap — the catalog is in-memory.
 *
 * @param modelId - the Anthropic model id to probe, e.g. `claude-opus-4-8`
 * @returns true if the catalog has an anthropic-messages model with that id
 */
export const isKnownAnthropicModel = (modelId: string): boolean => {
  const resolved = builtinModels().getModel(PROVIDER, modelId)
  return Boolean(resolved && hasApi(resolved, API))
}

/**
 * Narrows a dispatched `Model<Api>` to the anthropic-messages model this
 * provider exclusively serves, surfacing misuse loudly rather than guessing.
 */
const requireAnthropic = (model: Model<Api>): Model<typeof API> => {
  if (!hasApi(model, API)) {
    throw new Error(`Expected an "${API}" model, got "${model.api}".`)
  }
  return model
}

/**
 * Maps a Pi thinking level to an Anthropic adaptive-thinking effort, honoring a
 * model's `thinkingLevelMap` override (e.g. opus models remap `xhigh`). Mirrors
 * Pi's internal mapping, which is not exported.
 */
const mapThinkingLevelToEffort = (model: Model<typeof API>, level: ThinkingLevel): AnthropicEffort => {
  const mapped = model.thinkingLevelMap?.[level]
  // `EFFORTS.find` validates the catalog override as a real effort (type-safe,
  // no cast). Every Anthropic catalog override is valid, so this matches Pi.
  const override = typeof mapped === 'string' ? EFFORTS.find((effort) => effort === mapped) : undefined
  if (override) return override
  if (level === 'minimal' || level === 'low') return 'low'
  if (level === 'medium') return 'medium'
  return 'high'
}

/**
 * Re-implements Pi's `streamSimple` simple→full bridge so the `client` survives
 * into the full `stream` call. Reuses Pi's exported helpers for the parts that
 * are exported; only the (unexported) effort mapping is reproduced above.
 */
const toFullAnthropicOptions = (
  model: Model<typeof API>,
  context: Context,
  options?: SimpleStreamOptions,
): AnthropicOptions => {
  const base = buildBaseOptions(model, context, options, options?.apiKey)
  if (!options?.reasoning) {
    return { ...base, thinkingEnabled: false }
  }
  if (model.compat?.forceAdaptiveThinking === true) {
    return { ...base, thinkingEnabled: true, effort: mapThinkingLevelToEffort(model, options.reasoning) }
  }
  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens,
    model.maxTokens,
    options.reasoning,
    options.thinkingBudgets,
  )
  return {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  }
}

/**
 * Builds the `@anthropic-ai/sdk` client with the injected fetch, restoring the
 * static headers Pi would otherwise add for direct browser access.
 */
const createAnthropicClient = (model: Model<typeof API>, opts: BuildAnthropicModelOptions): Anthropic =>
  new Anthropic({
    apiKey: opts.apiKey,
    baseURL: model.baseUrl,
    fetch: opts.fetch,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      accept: 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  })

/**
 * Resolves an Anthropic model and wires it through a provider whose HTTP flows
 * through `opts.fetch`. Drop-in replacement for `resolveModel`: returns the same
 * `{ models, model }` shape the harness consumes.
 *
 * @param opts - api key, injected fetch, and the model id to resolve
 * @returns the wired provider collection and the resolved model
 * @throws if `opts.modelId` is not in Pi's built-in Anthropic catalog
 */
export const buildAnthropicModel = (opts: BuildAnthropicModelOptions): { models: Models; model: Model<Api> } => {
  const catalog = builtinModels()
  const resolved = catalog.getModel(PROVIDER, opts.modelId)
  if (!resolved || !hasApi(resolved, API)) {
    throw new Error(`Unknown Anthropic model "${opts.modelId}".`)
  }

  const client = createAnthropicClient(resolved, opts)
  const api: ProviderStreams = {
    stream: (model, context, options) => anthropicStream(requireAnthropic(model), context, { ...options, client }),
    streamSimple: (model, context, options) => {
      const narrowed = requireAnthropic(model)
      return anthropicStream(narrowed, context, { ...toFullAnthropicOptions(narrowed, context, options), client })
    },
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: PROVIDER,
      name: 'Anthropic',
      baseUrl: resolved.baseUrl,
      // Advisory only: the pre-built `client` owns the real credential
      // (`opts.apiKey`, bound for the session). This descriptor lets Pi's
      // status/credential-store reporting recognize the provider; the resolved
      // key never reaches the wire because the injected client is used as-is.
      auth: { apiKey: envApiKeyAuth('Anthropic API key', ['ANTHROPIC_API_KEY']) },
      models: [resolved],
      api,
    }),
  )

  return { models, model: resolved }
}
