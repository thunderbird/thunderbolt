/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Built-in adapter — the app's first-party agent, exposed through the same
 * `AgentAdapter` seam as every ACP agent. Selecting it must look identical to
 * the user: the chat layer calls `adapter.fetch(init, ctx)` and streams the
 * returned `Response` body unchanged.
 *
 * Engine routing (behind the seam, invisible to the chat layer):
 *
 *   - **Anthropic + OpenAI-wire models** (`anthropic`, plus the OpenAI-compatible
 *     family `openai`/`custom`/`openrouter`/`thunderbolt`) run on the in-browser
 *     Pi {@link AgentHarness} (`shared/agent-core`): a real coding agent
 *     (bash/read/write/edit over an OPFS-backed ZenFS sandbox) whose LLM HTTP
 *     flows through the app's per-provider fetch (proxy fetch, or the thunderbolt
 *     SSO fetch). Its Pi event stream is translated to the AI SDK v5 UI message
 *     stream by `piHarnessToUiMessageStream`. The engine is `import()`-ed lazily
 *     (see `fetchViaHarness`) so its weight stays off the chat entry chunk.
 *   - **tinfoil** (confidential enclave) and any model id the chosen Pi provider
 *     can't resolve fall back to the legacy `aiFetchStreamingResponse` pipeline.
 *     tinfoil is deferred: its `SecureClient` does attestation/HPKE through a
 *     bespoke async-acquired fetch that doesn't fit Pi's synchronous fetch-swap
 *     cheaply, so routing it to Pi would risk the confidential path.
 *
 * Each thread keeps a PERSISTENT harness (cached per `threadId` for the life of
 * the adapter), mirroring the ACP path's per-thread session model: the first turn
 * builds the harness (seeding any prior turns as history so a resumed conversation
 * has context — `buildAppHarness({ history })`), and every later turn prompts that
 * same live harness, whose session already holds the running transcript — no
 * re-seeding. The cache is tagged with a config SIGNATURE (model / provider / api
 * key / stable system prompt / thinking level / reasoning / regenerate revision):
 * switching any of these mid-thread rebuilds the harness from request-body history
 * (the workspace, keyed by `threadId`, is kept so its files survive the rebuild). Each thread's
 * harness is bound to its own isolated OPFS workspace (`/workspace/<threadId>`),
 * jailed so a thread's coding tools and shell can't reach another thread's files.
 * Built-in tools auto-run without a permission dialog because they execute in a
 * per-thread, network-less OPFS/ZenFS sandbox.
 *
 * No ACP handshake either way; `capabilities` is null and `ensureSession` is a
 * no-op (no wire to warm). `disconnect` is real: it disposes every cached harness
 * and removes its workspace, so no thread's session or files leak past the
 * adapter's teardown (agent delete / config edit / sign-out).
 */

import {
  aiFetchStreamingResponse,
  prepareAiRequestConfig,
  resolveOpenAiCompatConnection,
  type PreparedAiRequestConfig,
} from '@/ai/fetch'
import type { Agent, AgentAdapter, AgentAdapterContext } from '@/types/acp'
import type { Model, ModelProfile, ThunderboltUIMessage } from '@/types'
import type { PiModelDescriptor, SeedTurn } from '@shared/agent-core'
import { APP_HARNESS_ENVIRONMENT_PROMPT } from '@shared/agent-core/environment-prompt'
import type { AgentHarness, AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { prepareBuiltInConversation } from './built-in-conversation'

/** The type of the lazily-imported Pi engine module. A pure type reference — it
 *  resolves the module's shape for the compiler without emitting a runtime
 *  import, so the ~8MB engine stays in the async chunk loaded inside
 *  {@link fetchViaHarness}, never on the chat entry bundle. */
type AgentCoreModule = typeof import('@shared/agent-core')

/** A thread's live harness plus the workspace it is bound to. Kept in the
 *  per-adapter cache so the conversation (which lives in the harness session) and
 *  its isolated OPFS workspace persist across the thread's turns. */
type HarnessRecord = {
  readonly harness: AgentHarness
  /** The thread's isolated workspace dir ({@link workspaceDirFor}); removed on dispose. */
  readonly workspaceDir: string
  /** Coding tools owned by agent-core; app/MCP tools are replaced every send. */
  readonly baseTools: AgentTool[]
  /** Mutable prompt cell read by the harness's per-turn system-prompt callback. */
  readonly systemPrompt: { current: string }
}

/** A thread's cached build, tagged with the config {@link harnessSignature} it was
 *  built for so a mid-thread config switch is detected and rebuilt. */
type CachedHarness = {
  readonly signature: string
  /** The build PROMISE (see {@link HarnessCache}). */
  readonly record: Promise<HarnessRecord>
}

/** Per-thread harness cache: one persistent harness per chat thread, reused across
 *  that thread's turns while its config signature is unchanged. Stores the build
 *  PROMISE (not the resolved record) so concurrent first-turns dedupe to a single
 *  build; a failed build is evicted so the next turn retries against a fresh
 *  harness. */
type HarnessCache = Map<string, CachedHarness>

/** Stable and volatile prompt parts needed by the Pi harness. */
type AppHarnessSystemPromptConfig = Pick<PreparedAiRequestConfig, 'stableSystemPrompt' | 'volatileSystemPrompt'>

/** Production injection point — production binds to `aiFetchStreamingResponse`. */
export type AiFetchStreamingResponseFn = typeof aiFetchStreamingResponse

export type BuiltInAdapterOptions = {
  /** Inject for tests so we don't touch the AI SDK / DB / settings stack. Also
   *  the engine for every non-Pi provider (tinfoil/thunderbolt-proxy/openai/…). */
  aiFetch?: AiFetchStreamingResponseFn
  /** Lazy engine loader injection for adapter-level tests. */
  loadAgentCore?: () => Promise<AgentCoreModule>
  /** Shared per-send config preparation injection for adapter-level tests. */
  prepareConfig?: typeof prepareAiRequestConfig
}

/** Providers the in-browser Pi harness can serve. Everything else (tinfoil, plus
 *  any future provider) stays on the legacy pipeline. */
const piProviders = new Set<Model['provider']>(['anthropic', 'openai', 'custom', 'openrouter', 'thunderbolt'])

/** Valid Pi thinking levels, used to validate a profile-supplied effort string. */
const piThinkingLevels = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])

/** Reasoning depth used when a model carries no explicit profile config. Mirrors
 *  the adaptive default the anthropic path has always used, so deriving the level
 *  never regresses a model that didn't configure one. */
const fallbackThinkingLevel: ThinkingLevel = 'medium'

/** Maps an Anthropic-style thinking budget (tokens) to a Pi level by upper bound:
 *  ≤0 → off, ≤1024 → minimal, ≤4096 → low, ≤12288 → medium, else high. */
const budgetToThinkingLevel = (budget: number): ThinkingLevel => {
  if (budget <= 0) {
    return 'off'
  }
  if (budget <= 1024) {
    return 'minimal'
  }
  if (budget <= 4096) {
    return 'low'
  }
  if (budget <= 12288) {
    return 'medium'
  }
  return 'high'
}

/** Coerce a profile effort string to a Pi level. Maps the explicit "off" signals
 *  ('off'/'none') to `off`, accepts the Pi levels verbatim, and rejects anything
 *  else (returning null so the caller can keep looking / fall back). */
const effortToThinkingLevel = (value: unknown): ThinkingLevel | null => {
  if (typeof value !== 'string') {
    return null
  }
  if (value === 'none') {
    return 'off'
  }
  return piThinkingLevels.has(value as ThinkingLevel) ? (value as ThinkingLevel) : null
}

/** Pull a Pi thinking level out of a profile's `providerOptions`, the only
 *  per-model reasoning signal in the data model (there is no thinking-level
 *  column). Recognizes the OpenAI `reasoningEffort`/`reasoning_effort` strings,
 *  a nested `reasoning.effort`, and the Anthropic-style `thinking` object
 *  (`{ type: 'disabled' }` → off; `{ budgetTokens }` → bucketed level). Returns
 *  null when no reasoning config is present. */
const readProfileThinkingLevel = (
  providerOptions: Record<string, unknown> | null | undefined,
): ThinkingLevel | null => {
  if (!providerOptions) {
    return null
  }
  const direct =
    effortToThinkingLevel(providerOptions.reasoningEffort) ?? effortToThinkingLevel(providerOptions.reasoning_effort)
  if (direct) {
    return direct
  }
  const reasoning = providerOptions.reasoning
  if (reasoning && typeof reasoning === 'object') {
    const nested = effortToThinkingLevel((reasoning as { effort?: unknown }).effort)
    if (nested) {
      return nested
    }
  }
  const thinking = providerOptions.thinking
  if (thinking && typeof thinking === 'object') {
    const { type, budgetTokens } = thinking as { type?: unknown; budgetTokens?: unknown }
    if (type === 'disabled') {
      return 'off'
    }
    if (typeof budgetTokens === 'number') {
      return budgetToThinkingLevel(budgetTokens)
    }
  }
  return null
}

/** The Pi thinking level for a model: its explicit profile reasoning config, else
 *  the adaptive fallback. Used for the anthropic path (whose catalog model is
 *  natively adaptive) and as the effort for OpenAI-wire reasoning models. */
const deriveThinkingLevel = (profile: ModelProfile | null): ThinkingLevel =>
  readProfileThinkingLevel(profile?.providerOptions) ?? fallbackThinkingLevel

/** Whether an OpenAI-wire model should request reasoning at all. Only models
 *  whose profile configures a non-`off` effort opt in; without config (or with an
 *  explicit `off`/`disabled`) the synthetic Pi model stays non-reasoning (Pi then
 *  sends no `reasoning_effort`, matching the legacy pipeline, which only forwards
 *  configured providerOptions). */
const hasExplicitReasoning = (profile: ModelProfile | null): boolean => {
  const level = readProfileThinkingLevel(profile?.providerOptions)
  return level !== null && level !== 'off'
}

/** Parse the AI SDK request transcript for Pi-specific content preparation. */
const parseMessages = (init: RequestInit): ThunderboltUIMessage[] => {
  if (typeof init.body !== 'string') {
    throw new Error('Built-in adapter expects a string body on init')
  }
  return (JSON.parse(init.body) as { messages: ThunderboltUIMessage[] }).messages
}

/** A resolved Pi model descriptor plus the thinking level derived from its
 *  profile. A null result at the call site means the model isn't Pi-serviceable
 *  (an anthropic id Pi's catalog lacks, or an OpenAI-wire provider missing its
 *  api key / url) and the request falls back to the legacy pipeline. */
export type ResolvedPiModel = {
  readonly descriptor: PiModelDescriptor
  readonly thinkingLevel: ThinkingLevel
}

/** Resolve the selected model to a Pi descriptor + thinking level, or null to
 *  fall back to legacy. Anthropic ids must exist in Pi's built-in catalog;
 *  OpenAI-wire providers must resolve a connection (api key / url present). The
 *  thinking level is derived from the model's profile for both families. */
const resolvePiModel = (
  agentCore: AgentCoreModule,
  context: AgentAdapterContext,
  profile: ModelProfile | null,
): ResolvedPiModel | null => {
  const model = context.selectedModel
  const thinkingLevel = deriveThinkingLevel(profile)
  if (model.provider === 'anthropic') {
    if (!agentCore.isKnownAnthropicModel(model.model)) {
      return null
    }
    return {
      descriptor: {
        kind: 'anthropic',
        modelId: model.model,
        apiKey: model.apiKey ?? '',
        fetch: context.getProxyFetch(),
      },
      thinkingLevel,
    }
  }
  const connection = resolveOpenAiCompatConnection(model, context.getProxyFetch)
  // Pi's openai-completions client requires a bearer key (it throws on an empty
  // one with no auth header). A `custom` model pointing at a no-auth local
  // endpoint (ollama / llama.cpp) has no key, so it stays on the legacy pipeline
  // (which omits the Authorization header) rather than crashing the run.
  if (!connection || !connection.apiKey) {
    return null
  }
  return {
    descriptor: {
      kind: 'openai-compat',
      providerId: model.provider,
      modelId: model.model,
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      fetch: connection.fetch,
      reasoning: hasExplicitReasoning(profile),
      contextWindow: model.contextWindow ?? undefined,
    },
    thinkingLevel,
  }
}

/** Compact non-cryptographic fingerprint (FNV-1a) of a secret, so the harness
 *  signature can detect an api-key change without embedding the plaintext key. */
const hashSecret = (value: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Fingerprint every input baked into a thread's harness at build time — the
 *  descriptor (provider / model id / api key / base url / reasoning / context
 *  window), thinking level, stable system prompt, and regeneration revision.
 *  When it changes mid-thread (a model, provider, key, mode/system-prompt,
 *  thinking, or MCP-server switch) the cached harness is stale and
 *  {@link getOrBuildHarness} rebuilds it; an unchanged signature reuses the live
 *  harness. Tools are replaced per send, so live MCP client closures are not
 *  part of this build signature. */
export const harnessSignature = (
  resolved: ResolvedPiModel,
  stableSystemPrompt: string,
  regenerationRevision = 0,
): string => {
  const d = resolved.descriptor
  const model =
    d.kind === 'anthropic'
      ? `anthropic|${d.modelId}|${hashSecret(d.apiKey)}`
      : `openai-compat|${d.providerId}|${d.modelId}|${d.baseURL}|${hashSecret(d.apiKey)}|${d.reasoning}|${d.contextWindow ?? ''}`
  return `${model}|${resolved.thinkingLevel}|${stableSystemPrompt}|regenerate:${regenerationRevision}`
}

/** Compose Pi's cacheable prompt prefix while keeping the per-send timestamp last. */
const composeAppHarnessSystemPrompt = (config: AppHarnessSystemPromptConfig): string =>
  `${config.stableSystemPrompt}\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}\n\n${config.volatileSystemPrompt}`

/** Build a thread's harness from the lazily-loaded engine and bind it to the
 *  thread's isolated workspace with resolved model + thinking level. Per-send app
 *  and MCP tools are installed afterward by {@link prepareHarnessForSend}. `history` is seeded only
 *  HERE — on the first turn (a resumed conversation's prior turns) and on a
 *  config-drift rebuild (re-seeding the transcript into the fresh harness); an
 *  unchanged-config later turn reuses this harness, whose session already holds it. */
const buildHarnessRecord = async (
  agentCore: AgentCoreModule,
  context: AgentAdapterContext,
  resolved: ResolvedPiModel,
  history: readonly SeedTurn[],
  config: AppHarnessSystemPromptConfig,
): Promise<HarnessRecord> => {
  const systemPrompt = { current: composeAppHarnessSystemPrompt(config) }
  const harness = await agentCore.buildAppHarness({
    model: resolved.descriptor,
    systemPrompt: () => systemPrompt.current,
    thinkingLevel: resolved.thinkingLevel,
    threadId: context.threadId,
    history,
  })
  return {
    harness,
    workspaceDir: agentCore.workspaceDirFor(context.threadId),
    baseTools: harness.getTools(),
    systemPrompt,
  }
}

/** Refresh per-send prompt and app/MCP tool closures on a persistent harness. */
const prepareHarnessForSend = async (
  agentCore: AgentCoreModule,
  record: HarnessRecord,
  config: PreparedAiRequestConfig,
): Promise<void> => {
  record.systemPrompt.current = composeAppHarnessSystemPrompt(config)
  const tools = await agentCore.toPiAgentTools(config.toolset)
  const allTools = [...record.baseTools, ...tools]
  await record.harness.setTools(
    allTools,
    allTools.map((tool) => tool.name),
  )
}

/** Return the thread's cached harness, building it on first use and REBUILDING it
 *  when the config {@link harnessSignature} drifts (a mid-thread model / provider /
 *  key / mode / thinking switch). On drift the stale harness is evicted and its run
 *  aborted, but its workspace is KEPT — the rebuild re-seeds history from the
 *  request body and reuses the same `threadId`-keyed workspace, so the conversation
 *  context and the agent's files both survive. Concurrent first-turns share one
 *  in-flight build; a rejected build is evicted so a later turn retries fresh
 *  instead of replaying the poisoned promise. */
const getOrBuildHarness = (
  cache: HarnessCache,
  threadId: string,
  signature: string,
  build: () => Promise<HarnessRecord>,
): Promise<HarnessRecord> => {
  const cached = cache.get(threadId)
  if (cached && cached.signature === signature) {
    return cached.record
  }
  // Config drift (or first turn). On drift, abort the stale harness's run and
  // WAIT for that to settle before building the replacement, so the old and new
  // harness never write the shared (threadId-keyed) workspace concurrently. The
  // workspace dir is kept — the rebuild reuses the thread's files; a rejected
  // prior build is swallowed so the rebuild still proceeds.
  const previous = cached?.record
  const record = previous ? previous.then(abortHarness, () => {}).then(build) : build()
  record.catch(() => {
    if (cache.get(threadId)?.record === record) {
      cache.delete(threadId)
    }
  })
  cache.set(threadId, { signature, record })
  return record
}

/** Abort a harness's in-flight run WITHOUT removing its workspace. Used on a
 *  config-drift eviction, where the rebuilt harness reuses the same workspace. */
const abortHarness = async (record: HarnessRecord): Promise<void> => {
  await record.harness.abort().catch(() => {})
}

/** Tear down one thread's harness: abort any in-flight run, then remove its
 *  isolated workspace so no files leak. Optimistic — `remove` can't throw
 *  (`force`), and a benign idle-abort error is swallowed. */
const disposeHarness = async (record: HarnessRecord): Promise<void> => {
  await abortHarness(record)
  await record.harness.env.remove(record.workspaceDir, { recursive: true, force: true })
}

/** Dispose every cached harness and clear the cache. Fire-and-forget so the
 *  adapter's synchronous `disconnect` doesn't await teardown; a never-resolved or
 *  rejected build is swallowed so no straggler escapes as an unhandled rejection. */
const disposeAllHarnesses = (cache: HarnessCache): void => {
  const cached = [...cache.values()]
  cache.clear()
  void Promise.all(cached.map(({ record }) => record.then(disposeHarness).catch(() => {})))
}

/** Run the built-in request on the thread's persistent in-browser Pi harness and
 *  return its stream as the AI SDK UI message stream `Response`. Falls back to the
 *  legacy pipeline when the model isn't Pi-serviceable (unresolvable id/config). */
const fetchViaHarness = async (
  init: RequestInit,
  context: AgentAdapterContext,
  cache: HarnessCache,
  fallback: () => Promise<Response>,
  loadAgentCore: () => Promise<AgentCoreModule>,
  prepareConfig: typeof prepareAiRequestConfig,
): Promise<Response> => {
  // Sanctioned route-splitting exception (CLAUDE.md "Route-level Code Splitting").
  // The Pi engine (`pi-*`, `zenfs`, `just-bash`, `@anthropic-ai/sdk`, `openai` —
  // several MB) must NOT sit in the chat entry chunk on the critical landing path.
  // This dynamic import keeps it in a separate async chunk that loads only when a
  // built-in Pi agent actually runs; the legacy path's imports stay static.
  const agentCore = await loadAgentCore()

  // Resolve the model to a Pi descriptor; an unknown anthropic id or an
  // unconfigured OpenAI-wire provider falls back to the legacy pipeline so the
  // chat never crashes on a model Pi can't run.
  const config = await prepareConfig({
    modelId: context.selectedModel.id,
    modeSystemPrompt: context.selectedMode.systemPrompt ?? undefined,
    modeName: context.selectedMode.name ?? undefined,
    mcpClients: context.mcpClients,
    reconnectClient: context.reconnectClient,
    httpClient: context.httpClient,
  })
  const resolved = resolvePiModel(agentCore, context, config.profile)
  if (!resolved) {
    return fallback()
  }

  const { history, prompt } = await prepareBuiltInConversation(parseMessages(init), context.skillInstructions)

  // Build the thread's harness on its first turn (seeding `history`); reuse it on
  // every later turn whose config signature is unchanged, and rebuild it when the
  // signature drifts (a mid-thread model / provider / key / mode / thinking / MCP switch).
  const signature = harnessSignature(resolved, config.stableSystemPrompt, context.regenerationRevision)
  const record = await getOrBuildHarness(cache, context.threadId, signature, () =>
    buildHarnessRecord(agentCore, context, resolved, history, config),
  )
  await prepareHarnessForSend(agentCore, record, config)
  const { harness } = record

  return new Response(
    agentCore.piHarnessToUiMessageStream(
      harness,
      async () => {
        await harness.prompt(prompt.text, { images: prompt.images })
        await harness.waitForIdle()
      },
      {
        initial: { modelId: context.selectedModel.id },
        toolCall: (toolName) => {
          const owner = config.mcpToolsMetadata?.[toolName]
          return owner
            ? { modelId: context.selectedModel.id, mcpTools: { [toolName]: owner } }
            : { modelId: context.selectedModel.id }
        },
        settled: () => ({
          modelId: context.selectedModel.id,
          ...(config.sourceCollector.length > 0 ? { sources: [...config.sourceCollector] } : {}),
        }),
      },
    ),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/**
 * Build the built-in agent's {@link AgentAdapter}. Its `fetch` routes Anthropic
 * models to the in-browser Pi harness and every other provider to the legacy
 * `aiFetchStreamingResponse` pipeline (overridable via `options.aiFetch`).
 *
 * @param agent - the built-in `Agent` row this adapter represents
 * @param options - test/override seam for the legacy fetch engine
 * @returns an adapter with `capabilities: null` and no-op session lifecycle
 */
export const createBuiltInAdapter = (agent: Agent, options: BuiltInAdapterOptions = {}): AgentAdapter => {
  const aiFetch = options.aiFetch ?? aiFetchStreamingResponse
  const loadAgentCore = options.loadAgentCore ?? (() => import('@shared/agent-core'))
  const prepareConfig = options.prepareConfig ?? prepareAiRequestConfig

  // Per-thread harness cache, scoped to this adapter instance. The adapter is
  // itself cached per-agent (`adapter-cache.ts`), so a thread's harness survives
  // across all of that thread's turns; `disconnect` disposes them all.
  const harnessCache: HarnessCache = new Map()

  /** Legacy engine — every provider the Pi harness doesn't (yet) serve. */
  const fetchViaLegacyPipeline = (init: RequestInit, context: AgentAdapterContext): Promise<Response> =>
    aiFetch({
      init,
      modelId: context.selectedModel.id,
      modeSystemPrompt: context.selectedMode.systemPrompt ?? undefined,
      modeName: context.selectedMode.name ?? undefined,
      mcpClients: context.mcpClients,
      reconnectClient: context.reconnectClient,
      httpClient: context.httpClient,
      getProxyFetch: context.getProxyFetch,
    })

  // Route tool-capable Pi-serviceable models (anthropic + the OpenAI-wire family)
  // to the in-browser Pi harness; everything else (tinfoil, or a no-tools model
  // the harness can't honor since it always activates coding tools) stays on the
  // legacy pipeline. fetchViaHarness itself falls back when a candidate model
  // turns out to be unresolvable (unknown id / missing api key or url).
  const isPiCandidate = (model: Model): boolean => piProviders.has(model.provider) && model.toolUsage !== 0
  const fetch = (init: RequestInit, context: AgentAdapterContext): Promise<Response> =>
    isPiCandidate(context.selectedModel)
      ? fetchViaHarness(
          init,
          context,
          harnessCache,
          () => fetchViaLegacyPipeline(init, context),
          loadAgentCore,
          prepareConfig,
        )
      : fetchViaLegacyPipeline(init, context)

  return {
    agent,
    capabilities: null,
    fetch,
    // No ACP wire to warm. Each thread's harness IS persistent, so disconnect
    // disposes every cached harness and removes its isolated workspace.
    ensureSession: async () => {},
    disconnect: () => disposeAllHarnesses(harnessCache),
  }
}
