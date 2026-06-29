/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Builds a Pi-compatible OpenAI-completions model whose HTTP goes through an
 * injected `fetch`. This is the OpenAI-family analogue of
 * {@link buildAnthropicModel}: it serves every provider the app talks to over the
 * OpenAI Chat Completions wire — `openai`, `custom`, `openrouter`, and
 * `thunderbolt` (the backend proxy = openai-compatible against `cloudUrl`).
 *
 * Unlike the anthropic API, Pi's `openai-completions` provider exposes NO public
 * `client?`/`fetch?` seam: its `stream`/`streamSimple` construct the `openai` SDK
 * client internally via `new OpenAI({ apiKey, baseURL, defaultHeaders })` with no
 * `fetch` override, so the SDK resolves its fetch from `getDefaultFetch()` — the
 * global `fetch`. We therefore inject the app's proxy fetch by SYNCHRONOUSLY
 * swapping `globalThis.fetch` for the exact window in which Pi constructs that
 * client (see {@link withInjectedFetch}), then restoring it.
 *
 * Why the swap is race-free:
 *   - Pi's `stream()` runs an async IIFE whose SYNCHRONOUS prefix builds the
 *     OpenAI client (`createClient`) before the first `await`; `streamSimple()`
 *     calls `stream()` synchronously. The SDK captures `this.fetch` at
 *     construction, so the client is bound to our fetch inside the synchronous
 *     body of our wrapper.
 *   - JS is single-threaded and our swap window contains NO `await`, so no other
 *     code can observe the swapped global; we restore it in a `finally`. The
 *     captured fetch is what the SDK uses for the (later, async) HTTP, so the
 *     request flows through our fetch even after the global is restored.
 *
 * Documented reliances (re-verify on `@earendil-works/pi-ai` / `openai` bumps):
 *   1. openai-completions constructs its SDK client synchronously, before any
 *      `await`, inside `stream()`/`streamSimple()`.
 *   2. The `openai` SDK reads the global `fetch` via `getDefaultFetch()` when no
 *      `fetch` is passed to its constructor.
 *
 * Auth: the synthetic model carries `reasoning` (whether to request a reasoning
 * effort at all). The provider's advisory `auth` mirrors anthropic; the real
 * api key rides on the per-call options ({@link buildOpenAiCompatModel}'s `api`
 * injects `opts.apiKey`), since Pi's openai client reads `options.apiKey`.
 */

import {
  type Api,
  type Model,
  type Models,
  type ProviderStreams,
  createModels,
  createProvider,
  envApiKeyAuth,
  hasApi,
} from '@earendil-works/pi-ai'
import {
  stream as openaiStream,
  streamSimple as openaiStreamSimple,
} from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentFetch } from './anthropic-model.ts'

/** The Pi API this provider exclusively serves. */
const API = 'openai-completions'

/** Context window used when the app model carries none. Only consumed by Pi's
 *  token-budget math (irrelevant to openai-completions, which never caps tokens
 *  unless the caller passes `maxTokens`), so a generous default is harmless. */
const DEFAULT_CONTEXT_WINDOW = 128_000
/** Advisory max-output budget on the synthetic model. openai-completions only
 *  sends `max_completion_tokens` when the caller sets `options.maxTokens` (the
 *  harness does not), so this value never reaches the wire — it exists solely to
 *  satisfy the `Model` shape. */
const DEFAULT_MAX_TOKENS = 8_192

/** Inputs for {@link buildOpenAiCompatModel}. */
export type BuildOpenAiCompatModelOptions = {
  /** Pi provider id; must equal the synthetic model's `provider` so the
   *  `MutableModels` dispatch resolves this provider. Carries the app provider
   *  name (`openai` | `custom` | `openrouter` | `thunderbolt`). */
  readonly providerId: string
  /** Upstream model id sent on the wire, e.g. `opus-4.8` or `gpt-5`. */
  readonly modelId: string
  /** OpenAI-compatible base URL (e.g. `cloudUrl`, `https://openrouter.ai/api/v1`). */
  readonly baseURL: string
  /** Bearer key handed to the OpenAI SDK (may be a placeholder when the injected
   *  fetch supplies auth itself, e.g. thunderbolt SSO). */
  readonly apiKey: string
  /** Fetch every request is routed through — the provider-specific app fetch
   *  (proxy fetch, or the SSO-aware fetch for thunderbolt). */
  readonly fetch: AgentFetch
  /** Whether the model should request a reasoning effort. When false, Pi clamps
   *  any thinking level to `off` and sends no `reasoning_effort`. */
  readonly reasoning: boolean
  /** Optional upstream context window for the synthetic model descriptor. */
  readonly contextWindow?: number
}

/**
 * Synchronously route `globalThis.fetch` through `fetchImpl` for the duration of
 * `run()` — the window in which Pi constructs the OpenAI SDK client (which
 * captures the global fetch). Restores the original fetch unconditionally.
 *
 * The window spans Pi's synchronous prefix up to its first `await` (which builds
 * the client and then evaluates the `onPayload` hook). It contains NO `await`, so
 * it is race-free (see the module header). The only app code that can run in it is
 * the *synchronous* prefix of a harness `onPayload`/`onResponse` listener; the
 * built-in harness registers none that issue a fetch there, so nothing observes
 * the swapped global before it is restored.
 */
const withInjectedFetch = <T>(fetchImpl: AgentFetch, run: () => T): T => {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch
  try {
    return run()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Narrows a dispatched `Model<Api>` to the openai-completions model this provider
 * exclusively serves, surfacing misuse loudly rather than guessing. Mirrors
 * {@link buildAnthropicModel}'s `requireAnthropic`.
 */
const requireOpenAiCompletions = (model: Model<Api>): Model<typeof API> => {
  if (!hasApi(model, API)) {
    throw new Error(`Expected an "${API}" model, got "${model.api}".`)
  }
  return model
}

/** Synthesize the Pi `Model<"openai-completions">` descriptor. The app's models
 *  live outside Pi's built-in catalog (custom URLs, backend-proxied ids), so we
 *  build the descriptor directly rather than resolving it. */
const synthesizeModel = (opts: BuildOpenAiCompatModelOptions): Model<typeof API> => ({
  id: opts.modelId,
  name: opts.modelId,
  api: API,
  provider: opts.providerId,
  baseUrl: opts.baseURL,
  reasoning: opts.reasoning,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
})

/**
 * Resolves an OpenAI-compatible model and wires it through a provider whose HTTP
 * flows through `opts.fetch`. Drop-in sibling of {@link buildAnthropicModel}:
 * returns the same `{ models, model }` shape the harness consumes.
 *
 * @param opts - provider id, model id, base URL, api key, injected fetch, reasoning flag
 * @returns the wired provider collection and the synthetic model
 */
export const buildOpenAiCompatModel = (opts: BuildOpenAiCompatModelOptions): { models: Models; model: Model<Api> } => {
  const model = synthesizeModel(opts)

  // Inject the api key on every call (Pi's openai client reads `options.apiKey`)
  // and bind the fetch only around client construction via the synchronous swap.
  const api: ProviderStreams = {
    stream: (resolved, context, options) =>
      withInjectedFetch(opts.fetch, () =>
        openaiStream(requireOpenAiCompletions(resolved), context, { ...options, apiKey: opts.apiKey }),
      ),
    streamSimple: (resolved, context, options) =>
      withInjectedFetch(opts.fetch, () =>
        openaiStreamSimple(requireOpenAiCompletions(resolved), context, { ...options, apiKey: opts.apiKey }),
      ),
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: opts.providerId,
      name: opts.providerId,
      baseUrl: opts.baseURL,
      // Advisory only: the real credential rides on the per-call options above.
      // An empty env list makes resolution a graceful no-op in the browser.
      auth: { apiKey: envApiKeyAuth(`${opts.providerId} API key`, []) },
      models: [model],
      api,
    }),
  )

  return { models, model }
}
