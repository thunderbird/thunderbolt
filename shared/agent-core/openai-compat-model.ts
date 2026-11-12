/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Builds a Pi-compatible OpenAI model whose HTTP goes through an
 * injected `fetch`. Shared by the app and CLI, this is the OpenAI-family
 * analogue of {@link buildAnthropicModel}.
 *
 * Unlike the anthropic API, Pi's completions and Responses providers expose NO public
 * `client?`/`fetch?` seam: its `stream`/`streamSimple` construct the `openai` SDK
 * client internally via `new OpenAI({ apiKey, baseURL, defaultHeaders })` with no
 * `fetch` override, so the SDK resolves its fetch from `getDefaultFetch()` — the
 * global `fetch`. We therefore inject the caller's fetch by SYNCHRONOUSLY
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
 *   1. Both providers construct their SDK client synchronously, before any
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
  type MutableModels,
  type ProviderStreams,
  createModels,
  createProvider,
  hasApi,
} from '@earendil-works/pi-ai'
import {
  stream as openaiStream,
  streamSimple as openaiStreamSimple,
} from '@earendil-works/pi-ai/api/openai-completions'
import {
  stream as responsesStream,
  streamSimple as responsesStreamSimple,
} from '@earendil-works/pi-ai/api/openai-responses'
import { applyReasoningEffort, reasoningEffortFormat, type ReasoningEffort } from '../reasoning-effort.ts'
import { boundApiKeyAuth } from './bound-api-key-auth.ts'

/** Fetch shape used by OpenAI's client, which dispatches a serialized URL. */
export type OpenAiCompatFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Default protocol for OpenAI-compatible providers. */
const apiName = 'openai-completions'

/** Fallback context window when neither the deployment nor its catalog supplies one. */
const defaultContextWindow = 128_000
/** Conservative output budget for uncatalogued models. Pi's streamSimple sends
 *  model.maxTokens on the wire, capped to the remaining context window; reasoning
 *  and visible output share this budget for OpenAI-compatible providers. */
const defaultMaxTokens = 8_192

/** Inputs for {@link buildOpenAiCompatModel}. */
export type BuildOpenAiCompatModelOptions = {
  /** Public OpenAI wire protocol; ChatGPT plan tokens require Responses. */
  readonly api?: 'openai-completions' | 'openai-responses'
  /** Pi provider id. Must equal the synthetic model's `provider` so
   * `MutableModels` dispatch resolves this provider. */
  readonly providerId: string
  /** Upstream model id sent on the wire, e.g. `opus-4.8` or `gpt-5`. */
  readonly modelId: string
  /** OpenAI-compatible base URL (e.g. `cloudUrl`, `https://openrouter.ai/api/v1`). */
  readonly baseURL: string
  /** Bearer key handed to the OpenAI SDK (may be a placeholder when the injected
   *  fetch supplies auth itself, e.g. thunderbolt SSO). */
  readonly apiKey: string
  /** Fetch every request is routed through. */
  readonly fetch: OpenAiCompatFetch
  /** Whether the model should request a reasoning effort. When false, Pi clamps
   *  any thinking level to `off` and sends no `reasoning_effort`. */
  readonly reasoning: boolean
  /** Optional upstream context window for the synthetic model descriptor. */
  readonly contextWindow?: number
  /** Known upstream output limit, including reasoning. Passed through Pi's
   *  context-budget clamp instead of replacing catalog limits with the fallback. */
  readonly maxTokens?: number
  /** Whether the upstream model accepts image input. When false, the synthetic
   *  descriptor advertises text-only and Pi strips image blocks before the wire
   *  (`downgradeUnsupportedImages`), so a vision model would never see the bytes. */
  readonly supportsImages: boolean
  /** Provider-specific OpenAI compatibility behavior. */
  readonly compat?: Model<typeof apiName>['compat']
  /** Current per-conversation override. Undefined preserves the existing profile behavior. */
  readonly getReasoningEffort?: () => ReasoningEffort | undefined
  readonly effortFormat?: 'openai' | 'openrouter' | 'tinfoil'
  /** Provider-specific mapping from Pi thinking levels to wire efforts. */
  readonly thinkingLevelMap?: Model<typeof apiName>['thinkingLevelMap']
}

/**
 * Synchronously route `globalThis.fetch` through `fetchImpl` for the duration of
 * `run()` — the window in which Pi constructs the OpenAI SDK client (which
 * captures the global fetch). Restores the original fetch unconditionally.
 *
 * The window spans Pi's synchronous prefix up to its first `await` (which builds
 * the client and then evaluates the `onPayload` hook). It contains NO `await`, so
 * it is race-free (see the module header). Only the synchronous prefix of a
 * harness `onPayload`/`onResponse` listener can run before the global is restored.
 */
const withInjectedFetch = <T>(fetchImpl: OpenAiCompatFetch, run: () => T): T => {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl as typeof globalThis.fetch
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
const requireOpenAiCompletions = (model: Model<Api>): Model<typeof apiName> => {
  if (!hasApi(model, apiName)) {
    throw new Error(`Expected an "${apiName}" model, got "${model.api}".`)
  }
  return model
}

/** Synthesize the Pi model descriptor for the requested protocol. These models live
 *  outside Pi's built-in catalog (custom URLs, backend-proxied ids), so we
 *  build the descriptor directly rather than resolving it. */
const synthesizeModel = (opts: BuildOpenAiCompatModelOptions): Model<Api> => ({
  id: opts.modelId,
  name: opts.modelId,
  api: opts.api ?? apiName,
  provider: opts.providerId,
  baseUrl: opts.baseURL,
  reasoning: opts.reasoning,
  input: opts.supportsImages ? ['text', 'image'] : ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: opts.contextWindow ?? defaultContextWindow,
  maxTokens: opts.maxTokens ?? defaultMaxTokens,
  compat: opts.compat,
  thinkingLevelMap: opts.thinkingLevelMap,
})

/**
 * Resolves an OpenAI-compatible model and wires it through a provider whose HTTP
 * flows through `opts.fetch`. Drop-in sibling of {@link buildAnthropicModel}:
 * returns the same `{ models, model }` shape the harness consumes.
 *
 * @param opts - provider id, model id, base URL, api key, injected fetch, reasoning flag
 * @returns the wired provider collection and the synthetic model
 */
export const buildOpenAiCompatModel = (
  opts: BuildOpenAiCompatModelOptions,
): { models: MutableModels; model: Model<Api> } => {
  const model = synthesizeModel(opts)

  // Inject the api key on every call (Pi's openai client reads `options.apiKey`)
  // and bind the fetch only around client construction via the synchronous swap.
  const withEffort = (options: Parameters<ProviderStreams['stream']>[2]) => ({
    ...options,
    apiKey: opts.apiKey,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const transformed = await options?.onPayload?.(payload, model)
      return applyReasoningEffort(
        transformed ?? payload,
        opts.getReasoningEffort?.(),
        opts.api === 'openai-responses'
          ? 'openai-responses'
          : (opts.effortFormat ?? reasoningEffortFormat(opts.providerId)),
      )
    },
  })
  const api: ProviderStreams = {
    stream: (resolved, context, options) =>
      withInjectedFetch(opts.fetch, () =>
        hasApi(resolved, 'openai-responses')
          ? responsesStream(resolved, context, withEffort(options))
          : openaiStream(requireOpenAiCompletions(resolved), context, withEffort(options)),
      ),
    streamSimple: (resolved, context, options) =>
      withInjectedFetch(opts.fetch, () =>
        hasApi(resolved, 'openai-responses')
          ? responsesStreamSimple(resolved, context, withEffort(options))
          : openaiStreamSimple(requireOpenAiCompletions(resolved), context, withEffort(options)),
      ),
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: opts.providerId,
      name: opts.providerId,
      baseUrl: opts.baseURL,
      // Resolve the application-owned key without relying on browser environment variables.
      auth: { apiKey: boundApiKeyAuth(`${opts.providerId} API key`, opts.apiKey) },
      models: [model],
      api,
    }),
  )

  return { models, model }
}
