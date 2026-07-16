/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Builds a Pi `openai-completions` model bound to a custom base URL + bearer
 * key, so the CLI can run any OpenAI-compatible endpoint (e.g. Ollama at
 * `http://localhost:11434/v1`) outside Pi's built-in providers.
 *
 * This is the CLI sibling of `shared/agent-core/openai-compat-model.ts`, but
 * deliberately simpler. The app's version SYNCHRONOUSLY swaps `globalThis.fetch`
 * around Pi's SDK-client construction because it must route every call through
 * the browser CORS proxy and Pi's `openai-completions` exposes no `fetch` seam.
 * The CLI has no proxy: it runs in Bun with a real global `fetch`, and Pi builds
 * its client via `new OpenAI({ apiKey, baseURL: model.baseUrl })`, which natively
 * hits that base URL and sets `Authorization: Bearer <apiKey>` itself. So the only
 * wiring needed is (1) a synthetic model descriptor carrying the base URL and
 * (2) injecting the api key on Pi's per-call options (`getClientApiKey` returns
 * `options.apiKey` when present) — no global mutation, no fetch override.
 *
 * Documented reliance (re-verify on `@earendil-works/pi-ai` / `openai` bumps):
 * Pi's `openai-completions` `createClient` reads `model.baseUrl` and
 * `options.apiKey`; the `openai` SDK sends the bearer `Authorization` header.
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

/** The Pi API this provider exclusively serves. */
const API = 'openai-completions'

/** Context window used by Pi's token-budget math when the synthetic model
 *  carries none. openai-completions never caps tokens unless the caller passes
 *  `maxTokens` (the harness does not), so a generous default is harmless. */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Advisory max-output budget on the synthetic model. Only reaches the wire if
 *  the caller sets `options.maxTokens`; it exists solely to satisfy the `Model`
 *  shape. */
const DEFAULT_MAX_TOKENS = 8_192

/** Inputs for {@link buildOpenAiCompatModel}. */
export type BuildOpenAiCompatModelOptions = {
  /** Upstream model id sent on the wire, e.g. `llama3.3`. */
  readonly modelId: string
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string
  /** Bearer key handed to the OpenAI SDK (sent as `Authorization: Bearer <key>`). */
  readonly apiKey: string
}

/** Pi provider id for every CLI openai-compatible endpoint. */
const PROVIDER = 'openai-compat'

/** The raw Pi stream entry points this provider wraps. Injectable so the bearer
 *  key injection can be verified without a live OpenAI endpoint; defaults to the
 *  real `openai-completions` functions in production. */
export type OpenAiStreamFns = {
  readonly stream: typeof openaiStream
  readonly streamSimple: typeof openaiStreamSimple
}

const DEFAULT_STREAM_FNS: OpenAiStreamFns = { stream: openaiStream, streamSimple: openaiStreamSimple }

/**
 * Narrows a dispatched `Model<Api>` to the openai-completions model this
 * provider exclusively serves, surfacing misuse loudly rather than guessing.
 */
const requireOpenAiCompletions = (model: Model<Api>): Model<typeof API> => {
  if (!hasApi(model, API)) {
    throw new Error(`Expected an "${API}" model, got "${model.api}".`)
  }
  return model
}

/**
 * Synthesize the Pi `Model<"openai-completions">` descriptor. Custom-URL models
 * live outside Pi's built-in catalog, so we build the descriptor directly.
 * `reasoning: false` keeps the request portable across OpenAI-compatible
 * endpoints — Pi clamps the harness `thinkingLevel` to `off` and sends no
 * `reasoning_effort`, which a non-reasoning model would otherwise reject.
 */
const synthesizeModel = (opts: BuildOpenAiCompatModelOptions): Model<typeof API> => ({
  id: opts.modelId,
  name: opts.modelId,
  api: API,
  provider: PROVIDER,
  baseUrl: opts.baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
})

/**
 * Resolves an OpenAI-compatible model and wires it through a Pi provider bound
 * to `opts.baseUrl` + `opts.apiKey`. Drop-in sibling of `resolveModel`'s
 * built-in branch: returns the same `{ models, model }` shape the harness
 * consumes.
 *
 * @param opts - model id, base URL, and bearer api key
 * @param streamFns - the raw Pi stream functions to wrap (injectable for tests)
 * @returns the wired provider collection and the synthetic model
 */
export const buildOpenAiCompatModel = (
  opts: BuildOpenAiCompatModelOptions,
  streamFns: OpenAiStreamFns = DEFAULT_STREAM_FNS,
): { models: Models; model: Model<Api> } => {
  const model = synthesizeModel(opts)

  // Inject the api key on every call (Pi's openai client reads `options.apiKey`);
  // the SDK resolves the base URL from `model.baseUrl` and adds the bearer header.
  const api: ProviderStreams = {
    stream: (resolved, context, options) =>
      streamFns.stream(requireOpenAiCompletions(resolved), context, { ...options, apiKey: opts.apiKey }),
    streamSimple: (resolved, context, options) =>
      streamFns.streamSimple(requireOpenAiCompletions(resolved), context, { ...options, apiKey: opts.apiKey }),
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: PROVIDER,
      name: PROVIDER,
      baseUrl: opts.baseUrl,
      // Advisory only: the real credential rides on the per-call options above.
      // An empty env list makes env resolution a graceful no-op.
      auth: { apiKey: envApiKeyAuth(`${PROVIDER} API key`, []) },
      models: [model],
      api,
    }),
  )

  return { models, model }
}
