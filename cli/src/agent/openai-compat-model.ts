/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Builds a Pi `openai-completions` model bound to a custom provider, base URL,
 * credential, and optional fetch implementation.
 *
 * This is the CLI sibling of `shared/agent-core/openai-compat-model.ts`, but
 * Pi exposes no fetch option for this API. The standard path lets the SDK
 * synchronously capture a stable global dispatcher; AsyncLocalStorage then
 * selects the origin-bound transport for each call. A caller-owned prevalidated
 * transport instead replaces `globalThis.fetch` only during that synchronous
 * capture window and restores it immediately.
 *
 * Documented reliance (re-verify on `@earendil-works/pi-ai` / `openai` bumps):
 * Pi's `openai-completions` `createClient` reads `model.baseUrl` and
 * `options.apiKey`; the OpenAI SDK captures global fetch synchronously.
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
import {
  createCredentialedFetch,
  withCredentialedFetch,
  type CredentialedFetch,
  type CredentialResponseObserver,
} from './credentialed-fetch.ts'

/** The Pi API this provider exclusively serves. */
const apiId = 'openai-completions'

const defaultContextWindow = 128_000

const defaultMaxTokens = 8_192

/** Inputs for {@link buildOpenAiCompatModel}. */
export type BuildOpenAiCompatModelOptions = {
  /** Pi provider id; defaults to the legacy openai-compat provider. */
  readonly providerId?: string
  /** Upstream model id sent on the wire, e.g. `llama3.3`. */
  readonly modelId: string
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string
  /** Bearer key handed to the OpenAI SDK (sent as `Authorization: Bearer <key>`). */
  readonly apiKey: string
  /** Optional underlying transport; origin-bound unless `prevalidatedFetch` opts out. */
  readonly fetchFn?: OpenAiCompatFetch
  /** Observes authenticated HTTP evidence before the SDK parses the response. */
  readonly observeResponse?: CredentialResponseObserver
  /** Temporarily exposes a caller-owned fetch that already enforces its transport security policy. */
  readonly prevalidatedFetch?: boolean
  /** Whether Pi may send reasoning options for this model. */
  readonly reasoning?: boolean
  /** Context window advertised to Pi's token-budget calculations. */
  readonly contextWindow?: number
  /** Whether Pi may preserve image blocks in requests to this model. */
  readonly supportsImages?: boolean
  /** Provider-specific OpenAI compatibility behavior. */
  readonly compat?: Model<typeof apiId>['compat']
  /** Provider-specific mapping from Pi thinking levels to wire efforts. */
  readonly thinkingLevelMap?: Model<typeof apiId>['thinkingLevelMap']
}

/** Fetch shape used by OpenAI's client, which always dispatches a serialized URL. */
export type OpenAiCompatFetch = CredentialedFetch

/** Legacy provider id used when a caller does not own a distinct profile id. */
const defaultProviderId = 'openai-compat'

/** The raw Pi stream entry points this provider wraps. Injectable so the bearer
 *  key injection can be verified without a live OpenAI endpoint; defaults to the
 *  real `openai-completions` functions in production. */
export type OpenAiStreamFns = {
  readonly stream: typeof openaiStream
  readonly streamSimple: typeof openaiStreamSimple
}

const defaultStreamFns: OpenAiStreamFns = { stream: openaiStream, streamSimple: openaiStreamSimple }

/** Temporarily exposes a prevalidated fetch only for the SDK's synchronous client-capture window. */
const withPrevalidatedFetch = <Value>(fetchFn: OpenAiCompatFetch, run: () => Value): Value => {
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchFn })
  try {
    return run()
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalFetch })
  }
}

/**
 * Narrows a dispatched `Model<Api>` to the openai-completions model this
 * provider exclusively serves, surfacing misuse loudly rather than guessing.
 */
const requireOpenAiCompletions = (model: Model<Api>): Model<typeof apiId> => {
  if (!hasApi(model, apiId)) {
    throw new Error(`Expected an "${apiId}" model, got "${model.api}".`)
  }
  return model
}

/**
 * Synthesize the Pi `Model<"openai-completions">` descriptor. Custom-URL models
 * live outside Pi's built-in catalog, so we build the descriptor directly.
 * Reasoning and image input default off for legacy custom endpoints; managed
 * callers can advertise those capabilities from their validated catalog row.
 */
const synthesizeModel = (opts: BuildOpenAiCompatModelOptions): Model<typeof apiId> => ({
  id: opts.modelId,
  name: opts.modelId,
  api: apiId,
  provider: opts.providerId ?? defaultProviderId,
  baseUrl: opts.baseUrl,
  reasoning: opts.reasoning ?? false,
  input: opts.supportsImages ? ['text', 'image'] : ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: opts.contextWindow ?? defaultContextWindow,
  maxTokens: defaultMaxTokens,
  compat: opts.compat,
  thinkingLevelMap: opts.thinkingLevelMap,
})

/**
 * Resolves an OpenAI-compatible model and wires it through a Pi provider bound
 * to `opts.baseUrl` + `opts.apiKey`. Returns the `{ models, model }` shape the
 * harness consumes.
 *
 * @param opts - model id, base URL, and bearer api key
 * @param streamFns - the raw Pi stream functions to wrap (injectable for tests)
 * @returns the wired provider collection and the synthetic model
 */
export const buildOpenAiCompatModel = (
  opts: BuildOpenAiCompatModelOptions,
  streamFns: OpenAiStreamFns = defaultStreamFns,
): { models: Models; model: Model<Api> } => {
  const model = synthesizeModel(opts)
  const providerId = opts.providerId ?? defaultProviderId
  const credentialedFetch = createCredentialedFetch(
    opts.baseUrl,
    opts.fetchFn,
    opts.observeResponse,
  )
  /** Chooses the caller-validated transport or the standard origin-checked async-local binding. */
  const withFetch = <Value>(run: () => Value): Value =>
    opts.prevalidatedFetch && opts.fetchFn
      ? withPrevalidatedFetch(opts.fetchFn, run)
      : withCredentialedFetch(credentialedFetch, run)

  // Inject the api key on every call and, when requested, bind the fetch only
  // around the synchronous OpenAI-client construction window.
  const api: ProviderStreams = {
    stream: (resolved, context, options) =>
      withFetch(() =>
        streamFns.stream(requireOpenAiCompletions(resolved), context, { ...options, apiKey: opts.apiKey }),
      ),
    streamSimple: (resolved, context, options) =>
      withFetch(() =>
        streamFns.streamSimple(requireOpenAiCompletions(resolved), context, { ...options, apiKey: opts.apiKey }),
      ),
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: providerId,
      name: providerId,
      baseUrl: opts.baseUrl,
      // Advisory only: the real credential rides on the per-call options above.
      // An empty env list makes env resolution a graceful no-op.
      auth: { apiKey: envApiKeyAuth(`${providerId} API key`, []) },
      models: [model],
      api,
    }),
  )

  return { models, model }
}
