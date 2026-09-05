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
 *   - **Anthropic, OpenAI-wire, and confidential Tinfoil models** run on the
 *     in-browser Pi {@link AgentHarness} (`shared/agent-core`): a real coding agent
 *     (bash/read/write/edit over an OPFS-backed ZenFS sandbox) whose LLM HTTP
 *     flows through the app's per-provider fetch (proxy fetch, or the thunderbolt
 *     SSO fetch). Its Pi event stream is translated to the AI SDK v5 UI message
 *     stream by `piHarnessToUiMessageStream`. The engine is `import()`-ed lazily
 *     (see `fetchViaHarness`) so its weight stays off the chat entry chunk.
 *   - Any non-Tinfoil model id the chosen Pi provider can't resolve falls back
 *     to the legacy `aiFetchStreamingResponse` pipeline.
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
 * Built-in tools auto-run by product decision, restoring the pre-#1032 baseline
 * where the legacy pipeline ran every tool ungated. The harness also runs
 * network-capable app, integration, and MCP tools that are not sandboxed;
 * OPFS/ZenFS isolation is not the safety rationale for auto-run.
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
import { submitInferenceUsageReceipt } from '@/ai/inference-usage-receipt'
import type { WebToolBudget } from '@/ai/web-tool-budget'
import { webToolNames } from '@/lib/tools'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { appVersionHeader } from '@/lib/app-version'
import { handleAppVersionUnsupported } from '@/lib/app-version-unsupported'
import type { Agent, AgentAdapter, AgentAdapterContext } from '@/types/acp'
import type { Model, ModelProfile, ThunderboltUIMessage } from '@/types'
import { extractLastUserText, resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { getPlatform } from '@/lib/platform'
import type { PiModelDescriptor, SeedTurn } from '@shared/agent-core'
import { buildClientIdentityBlock } from '@shared/agent-core/client-identity'
import { appHarnessEnvironmentPrompt } from '@shared/agent-core/environment-prompt'
import { vendorSupportsImages } from '@shared/defaults/models'
import { inferenceModelHeader } from '@shared/inference-usage'
import type { AgentHarness, AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { SecureClient } from 'tinfoil'
import {
  evictSystemTinfoilClient,
  evictUserTinfoilClient,
  getSystemTinfoilClient,
  getTinfoilClient,
  isTinfoilTransportWedgedError,
} from '@/ai/tinfoil-client'
import { prepareBuiltInConversation } from './built-in-conversation'

/** The type of the lazily-imported Pi engine module. A pure type reference — it
 *  resolves the module's shape for the compiler without emitting a runtime
 *  import, so the ~8MB engine stays in the async chunk loaded inside
 *  {@link fetchViaHarness}, never on the chat entry bundle. */
type AgentCoreModule = typeof import('@shared/agent-core')

type CurrentHttpClient = { current: AgentAdapterContext['httpClient'] }

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
  /** Mutable transport cell read by the attached receipt lifecycle. */
  readonly receiptHttpClient?: CurrentHttpClient
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
type AppHarnessSystemPromptConfig = Pick<
  PreparedAiRequestConfig,
  'stableSystemPrompt' | 'volatileSystemPrompt' | 'supportsTools'
>

/** Production injection point — production binds to `aiFetchStreamingResponse`. */
export type AiFetchStreamingResponseFn = typeof aiFetchStreamingResponse

export type BuiltInAdapterOptions = {
  /** Inject for tests so we don't touch the AI SDK / DB / settings stack. */
  aiFetch?: AiFetchStreamingResponseFn
  /** Lazy engine loader injection for adapter-level tests. */
  loadAgentCore?: () => Promise<AgentCoreModule>
  /** Shared per-send config preparation injection for adapter-level tests. */
  prepareConfig?: typeof prepareAiRequestConfig
  /** Attested-client seams for adapter tests. */
  getSystemTinfoilClient?: typeof getSystemTinfoilClient
  getTinfoilClient?: typeof getTinfoilClient
  evictSystemTinfoilClient?: typeof evictSystemTinfoilClient
  evictUserTinfoilClient?: typeof evictUserTinfoilClient
  getAuthToken?: typeof getAuthToken
  isSsoMode?: typeof isSsoMode
}

type TinfoilClientOptions = Pick<
  BuiltInAdapterOptions,
  | 'getSystemTinfoilClient'
  | 'getTinfoilClient'
  | 'evictSystemTinfoilClient'
  | 'evictUserTinfoilClient'
  | 'getAuthToken'
  | 'isSsoMode'
>

/** Providers the in-browser Pi harness can serve. */
const piProviders = new Set<Model['provider']>([
  'anthropic',
  'openai',
  'custom',
  'openrouter',
  'thunderbolt',
  'tinfoil',
])

/** Whether production routes a model to the Pi harness. Tinfoil has no legacy fallback. */
export const isPiModelCandidate = (model: Pick<Model, 'provider' | 'toolUsage'>): boolean =>
  piProviders.has(model.provider) && (model.provider === 'tinfoil' || model.toolUsage !== 0)

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
  /** Attested transport identity used only to invalidate the local harness cache. */
  readonly tinfoilClient?: SecureClient
  /** Current receipt transport for the persistent managed harness. */
  readonly receiptHttpClient?: CurrentHttpClient
}

/** Time a Tinfoil client acquisition without changing its error behavior. */
const acquireTinfoilClient = async <Client>(
  acquire: () => Promise<Client>,
  telemetry: AgentAdapterContext['telemetry'],
): Promise<Client> => {
  telemetry?.startPhase('attestation')
  try {
    return await acquire()
  } finally {
    telemetry?.endPhase('attestation')
  }
}

/** Run one request through an attested client and evict only wedged transports. */
const fetchTinfoil = async (
  client: SecureClient,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  evictClient: () => void,
): Promise<Response> => {
  try {
    return await client.fetch(input, init)
  } catch (error) {
    if (isTinfoilTransportWedgedError(error)) {
      evictClient()
    }
    throw error
  }
}

/** Resolve the selected model to a Pi descriptor + thinking level, or null to
 *  fall back to legacy. Anthropic ids must exist in Pi's built-in catalog;
 *  OpenAI-wire providers must resolve a connection (api key / url present). The
 *  thinking level is derived from the model's profile for both families. */
export const resolvePiModel = async (
  agentCore: AgentCoreModule,
  context: AgentAdapterContext,
  profile: ModelProfile | null,
  options: TinfoilClientOptions = {},
): Promise<ResolvedPiModel | null> => {
  const model = context.selectedModel
  const thinkingLevel = deriveThinkingLevel(profile)
  if (model.provider === 'tinfoil') {
    if (model.isSystem === 1) {
      const acquireSystemClient = options.getSystemTinfoilClient ?? getSystemTinfoilClient
      const client = await acquireTinfoilClient(
        () =>
          acquireSystemClient({
            trace_id: context.telemetry?.traceId,
            engine: 'pi',
            provider: model.provider,
            model_id: model.id,
          }),
        context.telemetry,
      )
      const evictClient = options.evictSystemTinfoilClient ?? evictSystemTinfoilClient
      const readAuthToken = options.getAuthToken ?? getAuthToken
      const readSsoMode = options.isSsoMode ?? isSsoMode
      const receiptHttpClient = { current: context.httpClient }
      const fetch: PiModelDescriptor['fetch'] = async (input, init) => {
        const token = readAuthToken()
        const headers = new Headers(init?.headers)
        headers.set(inferenceModelHeader, model.model)
        for (const [key, value] of Object.entries(appVersionHeader())) {
          headers.set(key, value)
        }
        const upstreamInit: RequestInit = { ...init, headers }
        if (readSsoMode() && !token) {
          upstreamInit.credentials = 'include'
          headers.delete('authorization')
        } else if (token) {
          headers.set('Authorization', `Bearer ${token}`)
        }
        const response = await fetchTinfoil(client, input, upstreamInit, evictClient)
        handleAppVersionUnsupported(response.status)
        return response
      }
      const receipts = agentCore.createReceiptLifecycle({
        submit: (usage) => submitInferenceUsageReceipt(usage, receiptHttpClient.current),
        reportError: (error) => console.error(error),
      })
      return {
        descriptor: {
          kind: 'confidential',
          providerId: 'tinfoil',
          modelId: model.model,
          vendor: model.vendor,
          baseURL: client.getBaseURL()!,
          apiKey: 'thunderbolt-managed',
          fetch,
          receipts,
          reasoning: true,
          contextWindow: model.contextWindow ?? undefined,
          supportsImages: vendorSupportsImages(model.vendor),
        },
        thinkingLevel,
        tinfoilClient: client,
        receiptHttpClient,
      }
    }
    if (!model.apiKey) {
      throw new Error('No API key provided for Tinfoil provider')
    }
    const acquireUserClient = options.getTinfoilClient ?? getTinfoilClient
    const client = await acquireTinfoilClient(
      () =>
        acquireUserClient({
          trace_id: context.telemetry?.traceId,
          engine: 'pi',
          provider: model.provider,
          model_id: model.id,
        }),
      context.telemetry,
    )
    const evictClient = options.evictUserTinfoilClient ?? evictUserTinfoilClient
    const fetch: PiModelDescriptor['fetch'] = (input, init) => fetchTinfoil(client, input, init, evictClient)
    return {
      descriptor: {
        kind: 'openai-compat',
        providerId: 'tinfoil',
        modelId: model.model,
        baseURL: client.getBaseURL()!,
        apiKey: model.apiKey,
        fetch,
        reasoning: hasExplicitReasoning(profile),
        contextWindow: model.contextWindow ?? undefined,
        supportsImages: vendorSupportsImages(model.vendor),
      },
      thinkingLevel,
      tinfoilClient: client,
    }
  }
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
      // Pi's openai-compat descriptor is text-only by default; without this a
      // vision-capable hosted model (e.g. Thunderbolt Opus) has its image blocks
      // stripped before the wire and only sees the `[Attachment: …]` text label.
      supportsImages: vendorSupportsImages(model.vendor),
    },
    thinkingLevel,
  }
}

const tinfoilClientIds = new WeakMap<SecureClient, string>()

/** Return a short process-local identity for one attested client instance. */
const tinfoilClientId = (client: SecureClient): string => {
  const existing = tinfoilClientIds.get(client)
  if (existing) {
    return existing
  }
  const id = crypto.randomUUID().slice(0, 8)
  tinfoilClientIds.set(client, id)
  return id
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
 *  When it changes mid-thread (a model, provider, key, system-prompt,
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
  const vendor = d.kind === 'confidential' ? (d.vendor ?? '') : ''
  const clientId = resolved.tinfoilClient ? tinfoilClientId(resolved.tinfoilClient) : ''
  const model =
    d.kind === 'anthropic'
      ? `anthropic|${d.modelId}|${hashSecret(d.apiKey)}`
      : `${d.kind}|${d.providerId}|${d.modelId}|${vendor}|${d.baseURL}|${hashSecret(d.apiKey)}|${d.reasoning}|${d.contextWindow ?? ''}|${d.supportsImages}|${clientId}`
  return `${model}|${resolved.thinkingLevel}|${stableSystemPrompt}|regenerate:${regenerationRevision}`
}

/** Compose Pi's cacheable prompt prefix while keeping the per-send timestamp last. */
// Unlike assembleBuiltInModelInput, ACP harness deliberately keeps Pi's single-string system prompt shape.
// Exported so tests can assert the real stable prompt survives into this engine's shape.
export const composeAppHarnessSystemPrompt = (config: AppHarnessSystemPromptConfig): string => {
  const platform = getPlatform()
  const environment = platform === 'web' || platform === 'ios' || platform === 'android' ? platform : 'desktop'
  const clientIdentity = buildClientIdentityBlock({
    environment,
    appVersion: import.meta.env.VITE_APP_VERSION,
  })
  const environmentBlock = config.supportsTools ? `\n\n${appHarnessEnvironmentPrompt}` : ''
  return `${config.stableSystemPrompt}\n\n${clientIdentity}${environmentBlock}\n\n${config.volatileSystemPrompt}`
}

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
    receiptHttpClient: resolved.receiptHttpClient,
  }
}

/** Refresh per-send prompt and app/MCP tool closures on a persistent harness. */
const prepareHarnessForSend = async (
  agentCore: AgentCoreModule,
  record: HarnessRecord,
  config: PreparedAiRequestConfig,
  httpClient: AgentAdapterContext['httpClient'],
): Promise<void> => {
  record.systemPrompt.current = composeAppHarnessSystemPrompt(config)
  if (record.receiptHttpClient) {
    record.receiptHttpClient.current = httpClient
  }
  const tools = await agentCore.toPiAgentTools(config.toolset)
  const allTools = [...record.baseTools, ...tools]
  const activeToolNames = config.model.toolUsage === 0 ? [] : allTools.map((tool) => tool.name)
  await record.harness.setTools(allTools, activeToolNames)
}

/** Remove web capabilities and request completion once the live turn first denies a call. */
const installWebToolBudgetFloor = (harness: AgentHarness, webToolBudget?: WebToolBudget): (() => void) => {
  if (!webToolBudget) {
    return () => undefined
  }
  let notified = false
  return harness.on('tool_result', async () => {
    if (notified || !webToolBudget.probe.exhaustedAttempts) {
      return undefined
    }
    // Result hooks can overlap for parallel calls; claim notification before yielding.
    notified = true
    await harness.setActiveTools(
      harness
        .getActiveTools()
        .map(({ name }) => name)
        .filter((name) => !webToolNames.has(name)),
    )
    await harness.steer(
      'The web tool budget is exhausted. Complete the requested deliverable using the available evidence and remaining non-web capabilities. Disclose coverage gaps rather than claiming unsupported completeness.',
    )
    return undefined
  })
}

/** Return the thread's cached harness, building it on first use and REBUILDING it
 *  when the config {@link harnessSignature} drifts (a mid-thread model / provider /
 *  key / thinking switch). On drift the stale harness is evicted and its run
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
  tinfoilOptions: TinfoilClientOptions,
): Promise<Response> => {
  // Sanctioned route-splitting exception (CLAUDE.md "Route-level Code Splitting").
  // The Pi engine (`pi-*`, `zenfs`, `just-bash`, `@anthropic-ai/sdk`, `openai` —
  // several MB) must NOT sit in the chat entry chunk on the critical landing path.
  // This dynamic import keeps it in a separate async chunk that loads only when a
  // built-in Pi agent actually runs; the legacy path's imports stay static.
  context.telemetry?.startPhase('agent_core_load')
  const agentCore = await loadAgentCore()
  context.telemetry?.endPhase('agent_core_load')

  // Resolve the model to a Pi descriptor; an unknown anthropic id or an
  // unconfigured OpenAI-wire provider falls back to the legacy pipeline so the
  // chat never crashes on a model Pi can't run.
  const config = await prepareConfig({
    modelId: context.selectedModel.id,
    mcpClients: context.mcpClients,
    reconnectClient: context.reconnectClient,
    httpClient: context.httpClient,
    webToolBudget: context.webToolBudget,
    // Pulls in the owning project's instructions. They land in the stable
    // prompt, which `harnessSignature` fingerprints — so editing a project
    // mid-thread rebuilds the harness on the next send by itself.
    chatThreadId: context.threadId,
    telemetry: context.telemetry,
  })
  const resolved = await resolvePiModel(agentCore, context, config.profile, tinfoilOptions)
  if (!resolved) {
    context.telemetry?.setDimensions({ engine: 'legacy' })
    return fallback()
  }

  const messages = parseMessages(init)
  const instructionBySlug = new Map(config.skills.map(({ name, instruction }) => [name, instruction]))
  const skillInstructions = resolveSkillTokenInstructions(extractLastUserText(messages), instructionBySlug)
  const { history, prompt } = await prepareBuiltInConversation(messages, skillInstructions)

  // Build the thread's harness on its first turn (seeding `history`); reuse it on
  // every later turn whose config signature is unchanged, and rebuild it when the
  // signature drifts (a mid-thread model / provider / key / thinking / MCP switch).
  context.telemetry?.startPhase('harness_build')
  const signature = harnessSignature(resolved, config.stableSystemPrompt, context.regenerationRevision)
  const record = await getOrBuildHarness(cache, context.threadId, signature, () =>
    buildHarnessRecord(agentCore, context, resolved, history, config),
  )
  await prepareHarnessForSend(agentCore, record, config, context.httpClient)
  context.telemetry?.endPhase('harness_build')
  const { harness } = record
  context.telemetry?.setDimensions({ engine: 'pi' })

  return new Response(
    agentCore.piHarnessToUiMessageStream(
      harness,
      async () => {
        // A replay has no current-attempt tool history to synthesize from. The live
        // harness instead reaches the floor through tool_result and keeps its evidence.
        if (context.webToolBudget?.probe.isExhausted) {
          throw new Error('Web tool budget exhausted. Retry manually to start a new research attempt.')
        }
        const removeBudgetFloor = installWebToolBudgetFloor(harness, context.webToolBudget)
        try {
          await harness.prompt(prompt.text, { images: prompt.images })
          await harness.waitForIdle()
        } finally {
          removeBudgetFloor()
        }
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
 * Build the built-in agent's {@link AgentAdapter}. Its `fetch` routes
 * Pi-serviceable providers to the in-browser harness and every other model to
 * the legacy `aiFetchStreamingResponse` pipeline (overridable
 * via `options.aiFetch`).
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
      mcpClients: context.mcpClients,
      reconnectClient: context.reconnectClient,
      httpClient: context.httpClient,
      getProxyFetch: context.getProxyFetch,
      turnBudget: context.turnBudget,
      webToolBudget: context.webToolBudget,
      telemetry: context.telemetry,
    })

  // Route Pi-serviceable models to the in-browser harness. Tinfoil always takes
  // this route; other providers still fall back when their id/config is unusable.
  const fetch = (init: RequestInit, context: AgentAdapterContext): Promise<Response> => {
    if (isPiModelCandidate(context.selectedModel)) {
      return fetchViaHarness(
        init,
        context,
        harnessCache,
        () => fetchViaLegacyPipeline(init, context),
        loadAgentCore,
        prepareConfig,
        options,
      )
    }
    context.telemetry?.setDimensions({ engine: 'legacy' })
    return fetchViaLegacyPipeline(init, context)
  }

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
