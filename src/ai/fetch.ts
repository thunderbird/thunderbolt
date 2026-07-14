/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createPromptParts } from '@/ai/prompt'
import {
  buildStepOverrides,
  extractTextFromMessages,
  getNudgeMessagesFromProfile,
  hasToolCalls,
  inferenceDefaults,
  isFinalStep,
  shouldRetry,
} from '@/ai/step-logic'
import { getAllSkills, getIntegrationStatus, getModel, getModelProfile, getSettings } from '@/dal'
import { getMessage } from '@/dal/chat-messages'
import { extractLastUserText, resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { collectAskEntriesFromCache, formatAskResponsesNote } from '@/widgets/ask/lib'
import { getDb } from '@/db/database'
import { getLocalSetting } from '@/stores/local-settings-store'
import { hydrateAttachmentsAsFileParts } from '@/lib/attachments'
import { hydrateQuotesAsText } from '@/lib/quotes'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { fetch as baseFetch } from '@/lib/fetch'
import { isLoopbackHost } from '@/lib/mcp-url-validation'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createToolset, getAvailableTools, type ToolCallCache } from '@/lib/tools'
import type { Model, ModelProfile, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { HttpClient } from '@/lib/http'
import type { SecureClient } from 'tinfoil'
import { v7 as uuidv7 } from 'uuid'

// Currently @openrouter/ai-sdk-provider is NOT compatible with Vercel AI SDK v5. If you enable this, you will get the following error:
// > [Error] Chat error: – Error: Unhandled chunk type: text-start — run-tools-transformation.ts:275
// OpenRouter is working on a new version of their SDK that is compatible with Vercel AI SDK v5. We'll uncomment this when it's ready.
// import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import {
  APICallError,
  convertToModelMessages,
  createUIMessageStream,
  InvalidToolInputError,
  NoSuchToolError,
  createUIMessageStreamResponse,
  extractReasoningMiddleware,
  smoothStream,
  stepCountIs,
  streamText,
  UnsupportedFunctionalityError,
  wrapLanguageModel,
  type Tool,
  type ToolSet,
} from 'ai'
import { type MCPClient } from '@ai-sdk/mcp'
import type { NamedMCPClient } from '@/lib/mcp-provider'
import { isClosedConnectionError } from '@/lib/mcp-errors'
import { smoothStreamWordDelayMs } from '@/chats/chat-throttle'
import { detectStreamChunk } from './smooth-chunking'
import { createMessageMetadata } from './message-metadata'

/**
 * Sanitizes a server name into a valid tool prefix.
 * Server names are already meaningful (set by user or auto-generated),
 * so this just lowercases and replaces non-alphanumeric chars with underscores.
 * `mcp_servers.name` is a nullable synced column, so a null/missing name falls
 * back to the generic `mcp` prefix rather than crashing the chat send.
 */
export const sanitizeToolPrefix = (serverName: string | null | undefined): string =>
  (serverName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'mcp'

/** Wrap fetch to include credentials in SSO mode so session cookies are sent to the backend. */
const fetch: typeof baseFetch = (input, init) =>
  baseFetch(input, isSsoMode() ? { ...init, credentials: 'include' } : init)
fetch.preconnect = baseFetch.preconnect

export const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  // compatibility: 'compatible',
  apiKey: 'ollama',
  fetch,
})

// Cached so attestation runs once per page load. `tinfoil` is dynamically
// imported to code-split its attestation/crypto deps.
//
// system: HPKE body POSTs to <cloudUrl>/tinfoil; backend injects our key.
// user:   BYOK — direct to the enclave with the user's own key.
//
// System cache is keyed by cloudUrl so a dev-tools URL switch hits the new
// backend on the next call.
const systemTinfoilClients = new Map<string, Promise<SecureClient>>()
let userTinfoilClient: SecureClient | null = null

/**
 * Build a fresh system `SecureClient` promise and cache it synchronously
 * (before the dynamic `import('tinfoil')` resolves) so a prewarm and an
 * immediate first send share one client and attest once instead of racing into
 * two attestations. On construction failure we drop the entry so the next call
 * retries the import rather than inheriting a sticky rejection.
 */
const createSystemTinfoilClient = (cloudUrl: string): Promise<SecureClient> => {
  const clientPromise = import('tinfoil').then(
    ({ SecureClient }) => new SecureClient({ baseURL: `${cloudUrl}/tinfoil` }),
  )
  void clientPromise.catch(() => systemTinfoilClients.delete(cloudUrl))
  systemTinfoilClients.set(cloudUrl, clientPromise)
  return clientPromise
}

export const getSystemTinfoilClient = async (): Promise<SecureClient> => {
  // cloudUrl already ends in /v1 (shared with the OpenAI chat baseURL).
  const cloudUrl = getLocalSetting('cloudUrl').replace(/\/$/, '')
  // Reuse the cached construction promise across concurrent callers; `ready()`
  // is awaited per call below (idempotent once attested).
  const client = await (systemTinfoilClients.get(cloudUrl) ?? createSystemTinfoilClient(cloudUrl))
  await client.ready()
  return client
}

/**
 * Best-effort warm-up of the Tinfoil system enclave so the first chat send
 * doesn't pay the attestation handshake on the critical path. Fired (fire-and-
 * forget) from the chat-ready path for the built-in agent only — see
 * {@link useHydrateChatStore}; ACP agents route over the wire and never reach
 * {@link createModel}. No-op unless `model` is a Tinfoil *system* model (the
 * only path that attests via {@link getSystemTinfoilClient}); BYO/other
 * providers never attest here.
 *
 * Idempotent: `getSystemTinfoilClient` memoizes per cloudUrl, so repeated warm-
 * ups and a concurrent real send share the same in-flight client. Errors are
 * swallowed ONLY here because this is a speculative cache fill — the real send
 * still surfaces attestation failures loudly through {@link createModel}.
 */
export const prewarmSystemModel = async (model: Pick<Model, 'provider' | 'isSystem'> | null | undefined) => {
  if (!model || model.provider !== 'tinfoil' || !model.isSystem) {
    return
  }
  try {
    await getSystemTinfoilClient()
  } catch (error) {
    console.warn('prewarmSystemModel: warm-up skipped', error)
  }
}

/** Drop the cached `SecureClient` so the next send constructs a fresh one with
 *  a new attestation context. Use when a key-config error keeps repeating
 *  inside the SDK's own reset+retry — the cached client's transport is wedged
 *  and only a brand-new instance breaks the cycle. */
const evictSystemTinfoilClient = (): void => {
  const cloudUrl = getLocalSetting('cloudUrl').replace(/\/$/, '')
  systemTinfoilClients.delete(cloudUrl)
}

export const getTinfoilClient = async (): Promise<SecureClient> => {
  if (!userTinfoilClient) {
    const { SecureClient } = await import('tinfoil')
    userTinfoilClient = new SecureClient()
  }
  await userTinfoilClient.ready()
  return userTinfoilClient
}

const evictUserTinfoilClient = (): void => {
  userTinfoilClient = null
}

/** A KeyConfigMismatchError that survives the SDK's internal reset+retry means
 *  our cached `SecureClient` has a wedged transport. Evict it so the next call
 *  builds a fresh instance with a brand-new attestation context. */
const isKeyConfigMismatchError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'KeyConfigMismatchError'

/** Reconnect a dropped MCP client; returns a fresh client or null. Supplied by
 *  the MCP provider via the chat store. See `src/lib/mcp-provider.tsx`. */
type ReconnectClient = (client: MCPClient) => Promise<MCPClient | null>

type AiFetchStreamingResponseOptions = {
  init: RequestInit
  modelId: string
  modeSystemPrompt?: string
  modeName?: string
  mcpClients?: NamedMCPClient[]
  reconnectClient?: ReconnectClient
  httpClient: HttpClient
  /** Returns the current proxy fetch. Production callers pass the getter from
   *  `ProxyFetchProvider` (`useProxyFetchGetter()`); non-React callers (eval
   *  scripts) build a `proxyFetch` directly and wrap it in `() => fn`. */
  getProxyFetch: () => FetchFn
}

/**
 * Merge every enabled MCP server's tools into `toolset` (mutated in place and
 * returned alongside a human-readable summary). Each tool is namespaced
 * `<prefix>_<toolName>` where `prefix` is the server name sanitized via
 * {@link sanitizeToolPrefix} — so two servers that both expose `list_services`
 * stay distinct and the model knows which server owns each tool. Servers whose
 * names sanitize to the same prefix are disambiguated by probing upward
 * (`render`, `render_2`, …); each final prefix is reserved, so a later server
 * that itself sanitizes to a generated prefix (`render_2`) is bumped again.
 *
 * Per server we call `tools()`; if it rejects with a closed-connection error we
 * reconnect once and retry. A reconnect that fails or a second `tools()` failure
 * skips that server — discovery must never block the send. Non-closed errors
 * propagate so real failures aren't masked. After prefixing, a name that still
 * collides with an already-registered tool is skipped (first-registered wins) as
 * a safety net. The returned `summary` lists `- <prefix> (<n> tools)` per server
 * (undefined when no MCP tools were added), injected into the system prompt.
 *
 * Also returns `mcpTools`, mapping each namespaced tool name (`<prefix>_<tool>`)
 * to its owning server's `{ name, url }` plus the bare `toolName`. This is the
 * only place that knows the exact name→server ownership (it builds the names and
 * skips collisions), so it rides on the assistant message metadata to let chat
 * history resolve a `dynamic-tool` part back to its server's display name, url,
 * and icon by exact lookup — no display-time prefix heuristics. Only tools that
 * actually merged are included. Injectable for unit tests.
 */
export const mergeMcpTools = async (
  toolset: Record<string, Tool>,
  mcpClients: NamedMCPClient[],
  reconnectClient: ReconnectClient,
): Promise<{ toolset: Record<string, Tool>; summary?: string; mcpTools: UIMessageMetadata['mcpTools'] }> => {
  const takenPrefixes = new Set<string>()
  const mcpServerEntries: string[] = []
  const mcpTools: NonNullable<UIMessageMetadata['mcpTools']> = {}

  /** Prefix and merge one server's tools, recording each into `mcpTools` and
   *  returning how many were added. */
  const addTools = (
    prefix: string,
    server: { name: string; url: string },
    tools: Awaited<ReturnType<MCPClient['tools']>>,
  ): number => {
    let added = 0
    for (const [name, tool] of Object.entries(tools)) {
      const prefixedName = `${prefix}_${name}`
      if (toolset[prefixedName]) {
        console.warn(`MCP tool "${prefixedName}" from "${server.name}" conflicts with an existing tool and was skipped`)
        continue
      }
      toolset[prefixedName] = tool as Tool
      mcpTools[prefixedName] = { name: server.name, url: server.url, toolName: name }
      added++
    }
    return added
  }

  for (const { name: serverName, url, client } of mcpClients) {
    const basePrefix = sanitizeToolPrefix(serverName)
    let prefix = basePrefix
    let suffix = 2
    while (takenPrefixes.has(prefix)) {
      prefix = `${basePrefix}_${suffix}`
      suffix++
    }
    takenPrefixes.add(prefix)

    const server = { name: serverName, url }
    const merge = async (): Promise<number> => {
      try {
        return addTools(prefix, server, await client.tools())
      } catch (err) {
        if (!isClosedConnectionError(err)) {
          throw err
        }
        const fresh = await reconnectClient(client)
        if (!fresh) {
          console.warn('MCP server reconnect failed; skipping its tools for this send')
          return 0
        }
        try {
          return addTools(prefix, server, await fresh.tools())
        } catch (retryErr) {
          console.warn('MCP server still failing after reconnect; skipping its tools for this send', retryErr)
          return 0
        }
      }
    }

    const added = await merge()
    if (added > 0) {
      mcpServerEntries.push(`- ${prefix} (${added} ${added === 1 ? 'tool' : 'tools'})`)
    }
  }

  return {
    toolset,
    summary: mcpServerEntries.length > 0 ? mcpServerEntries.join('\n') : undefined,
    mcpTools: Object.keys(mcpTools).length > 0 ? mcpTools : undefined,
  }
}

/** Raw OpenAI-compatible connection for a model: the three knobs every
 *  OpenAI-wire provider construction needs ({@link createModel} for the legacy
 *  Vercel SDK, the in-browser Pi harness for the built-in agent). `fetch` is the
 *  provider-specific app fetch — the universal proxy fetch for
 *  `openai`/`custom`/`openrouter`, or the SSO-aware fetch for `thunderbolt`. */
export type OpenAiCompatConnection = {
  baseURL: string
  apiKey: string
  fetch: FetchFn
}

/**
 * Resolve the raw OpenAI-compatible connection for a model, mirroring the
 * per-provider construction in {@link createModel}. Returns `null` for providers
 * the OpenAI wire doesn't serve (`anthropic` has its own SDK; `tinfoil` needs the
 * enclave client) or when required config is missing (no api key / url) — callers
 * fall back to the legacy pipeline rather than crash.
 *
 * Centralizes the intricate `thunderbolt` SSO-fetch logic so the legacy and Pi
 * paths can't drift.
 *
 * @param modelConfig - the model whose connection to resolve
 * @param getProxyFetch - lazily resolved universal proxy fetch
 * @returns the connection, or `null` when unsupported/unconfigured
 */
export const resolveOpenAiCompatConnection = (
  modelConfig: Model,
  getProxyFetch: () => FetchFn,
): OpenAiCompatConnection | null => {
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      const cloudUrl = getLocalSetting('cloudUrl')
      const token = getAuthToken() || 'thunderbolt'
      // See the `thunderbolt` case in createModel for the SSO/token rationale:
      // SSO web has no bearer token (cookie auth), so strip the placeholder
      // Authorization and send credentials; Tauri SSO keeps its real bearer.
      const sso = isSsoMode()
      const hasRealToken = Boolean(getAuthToken())
      const ssoFetch: typeof fetch = Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          headers.delete('authorization')
          return fetch(input, { ...init, headers, credentials: 'include' })
        },
        { preconnect: fetch.preconnect },
      )
      const providerFetch: FetchFn = sso && !hasRealToken ? ssoFetch : fetch
      return { baseURL: cloudUrl, apiKey: token, fetch: providerFetch }
    }
    case 'openai':
      return modelConfig.apiKey
        ? { baseURL: 'https://api.openai.com/v1', apiKey: modelConfig.apiKey, fetch: getProxyFetch() }
        : null
    case 'custom': {
      if (!modelConfig.url) {
        return null
      }
      // Canonicalise `/v1` and dispatch loopback vs proxy right here, so BOTH
      // consumers of this connection (`createModel` legacy path and
      // `resolvePiModel` built-in agent path) see the same `baseURL` + `fetch`
      // and can't drift. Loopback Custom URLs (LM Studio at localhost:1234,
      // Ollama, `127.x.x.x`, `[::1]`, `*.localhost`) skip the universal proxy
      // so `localhost` means what the browser sees, not what the backend
      // container sees. Everything else — RFC1918 LAN IPs, `host.docker.internal`,
      // mDNS `.local`, public endpoints — stays on the proxy path (browser
      // blocks non-loopback http from https origins as mixed content, and
      // public Custom endpoints rely on the proxy for CORS bypass; THU-424).
      const baseURL = normalizeOpenAiBaseUrl(modelConfig.url)
      const hostname = URL.canParse(baseURL) ? new URL(baseURL).hostname : ''
      const providerFetch: FetchFn = isLoopbackHost(hostname) ? baseFetch : getProxyFetch()
      return { baseURL, apiKey: modelConfig.apiKey ?? '', fetch: providerFetch }
    }
    case 'openrouter':
      return modelConfig.apiKey
        ? { baseURL: 'https://openrouter.ai/api/v1', apiKey: modelConfig.apiKey, fetch: getProxyFetch() }
        : null
    default:
      return null
  }
}

export const createModel = async (modelConfig: Model, getProxyFetch: () => FetchFn) => {
  // The thunderbolt provider goes through its own SSO-aware fetch below; all
  // other providers route through the universal proxy. We resolve the proxy
  // fetch lazily so a settings change between chat creation and this call
  // (e.g. cloudUrl, proxy_enabled toggle) is picked up.
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      // SSO web flow authenticates via session cookies — the SSO callback is a
      // browser redirect, not an XHR, so `set-auth-token` never reaches the
      // client and getAuthToken() returns null.  The AI SDKs require an apiKey
      // to initialize, so we keep the placeholder 'thunderbolt' but strip the
      // resulting invalid Authorization header — otherwise Better Auth's bearer
      // plugin would try the placeholder first and 401 before falling back to
      // the cookie.
      //
      // Tauri desktop SSO uses a loopback server that returns a real bearer
      // token (stored via setAuthToken).  In that case we must keep the
      // Authorization header because WKWebView can't send cross-origin cookies.
      // The connection (baseURL/apiKey/SSO-fetch) lives in
      // resolveOpenAiCompatConnection so the Pi harness reuses the same logic.
      const conn = resolveOpenAiCompatConnection(modelConfig, getProxyFetch)
      if (!conn) {
        throw new Error('No connection resolved for thunderbolt provider')
      }
      const { baseURL, apiKey, fetch: providerFetch } = conn
      // OpenAI-vendor thunderbolt models use createOpenAI with .chat() to force Chat Completions API
      // (AI SDK 5 defaults createOpenAI to Responses API which our backend doesn't support)
      if (modelConfig.vendor === 'openai') {
        const provider = createOpenAI({ baseURL, apiKey, fetch: providerFetch })
        return provider.chat(modelConfig.model)
      }
      const provider = createOpenAICompatible({
        name: 'thunderbolt',
        baseURL,
        apiKey,
        fetch: providerFetch,
      })
      return provider(modelConfig.model)
    }
    case 'anthropic': {
      // Route Anthropic through the universal proxy. Hosted mode (web) sends
      // the request to /v1/proxy with Authorization rewritten to
      // X-Proxy-Passthrough-Authorization; Standalone mode (Tauri) hits
      // Anthropic directly via the Rust HTTP plugin. Either way, the user's
      // Anthropic key never goes through Thunderbolt's session auth path.
      const anthropic = createAnthropic({
        apiKey: modelConfig.apiKey || '',
        fetch: getProxyFetch(),
      })
      return anthropic(modelConfig.model)
    }
    case 'openai': {
      const conn = resolveOpenAiCompatConnection(modelConfig, getProxyFetch)
      if (!conn) {
        throw new Error('No API key provided')
      }
      const openai = createOpenAI({
        apiKey: conn.apiKey,
        fetch: conn.fetch,
      })
      return openai(modelConfig.model)
    }
    case 'custom': {
      const conn = resolveOpenAiCompatConnection(modelConfig, getProxyFetch)
      if (!conn) {
        throw new Error('No URL provided for custom provider')
      }
      // `conn.baseURL` and `conn.fetch` already carry the `/v1` normalization
      // and the loopback-vs-proxy dispatch (see resolveOpenAiCompatConnection).
      // Both the legacy path here and the Pi path in `resolvePiModel` read
      // through the same connection object, so their upstream URL + transport
      // stay in lockstep by construction.
      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: conn.baseURL,
        apiKey: conn.apiKey || undefined,
        fetch: conn.fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'openrouter': {
      const conn = resolveOpenAiCompatConnection(modelConfig, getProxyFetch)
      if (!conn) {
        throw new Error('No API key provided')
      }
      // Using OpenAI-compatible approach until @openrouter/ai-sdk-provider supports Vercel AI SDK v5
      // https://github.com/OpenRouterTeam/ai-sdk-provider/pull/77
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: conn.baseURL,
        apiKey: conn.apiKey,
        fetch: conn.fetch,
      })
      return openrouter(modelConfig.model)
    }
    case 'tinfoil': {
      // System Tinfoil models proxy through Thunderbolt's backend; the bearer
      // key is injected server-side, so we pass a placeholder here only to
      // satisfy the SDK's apiKey requirement. User-added Tinfoil models keep
      // the BYOK flow and require a real key.
      if (modelConfig.isSystem) {
        const client = await getSystemTinfoilClient()
        // Wrap SecureClient.fetch so the backend route's auth guard sees the
        // real Thunderbolt session token (Bearer) or cookies (SSO), not the
        // `Bearer thunderbolt-managed` placeholder the OpenAI SDK adds.
        const sso = isSsoMode()
        const token = getAuthToken()
        const wrappedFetch: typeof fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            const upstreamInit: RequestInit = { ...init, headers }
            if (sso && !token) {
              upstreamInit.credentials = 'include'
              headers.delete('authorization')
            } else if (token) {
              headers.set('Authorization', `Bearer ${token}`)
            }
            try {
              return await client.fetch(input, upstreamInit)
            } catch (err) {
              if (isKeyConfigMismatchError(err)) {
                evictSystemTinfoilClient()
              }
              throw err
            }
          },
          { preconnect: fetch.preconnect },
        )
        const tinfoil = createOpenAICompatible({
          name: 'tinfoil',
          baseURL: client.getBaseURL()!,
          apiKey: 'thunderbolt-managed',
          fetch: wrappedFetch,
        })
        return tinfoil(modelConfig.model)
      }
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const client = await getTinfoilClient()
      const evictingFetch: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          try {
            return await client.fetch(input, init)
          } catch (err) {
            if (isKeyConfigMismatchError(err)) {
              evictUserTinfoilClient()
            }
            throw err
          }
        },
        { preconnect: fetch.preconnect },
      )
      const tinfoil = createOpenAICompatible({
        name: 'tinfoil',
        baseURL: client.getBaseURL()!,
        apiKey: modelConfig.apiKey,
        fetch: evictingFetch,
      })
      return tinfoil(modelConfig.model)
    }
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`)
  }
}

export type PreparedAiRequestConfig = {
  readonly model: Model
  readonly profile: ModelProfile | null
  readonly supportsTools: boolean
  readonly sourceCollector: SourceMetadata[]
  readonly toolset: Record<string, Tool>
  readonly mcpToolsMetadata: UIMessageMetadata['mcpTools']
  readonly stableSystemPrompt: string
  readonly systemPrompt: string
}

export type PrepareAiRequestConfigOptions = {
  readonly modelId: string
  readonly modeSystemPrompt?: string
  readonly modeName?: string
  readonly mcpClients?: NamedMCPClient[]
  readonly reconnectClient?: ReconnectClient
  readonly httpClient: HttpClient
}

/** Load model/profile/settings and build one send's app + MCP tools and prompt. */
export const prepareAiRequestConfig = async ({
  modelId,
  modeSystemPrompt,
  modeName,
  mcpClients = [],
  reconnectClient = async () => null,
  httpClient,
}: PrepareAiRequestConfigOptions): Promise<PreparedAiRequestConfig> => {
  const db = getDb()
  const settings = await getSettings(db, {
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
    integrations_do_not_ask_again: false,
    experimental_feature_tasks: false,
    integrations_pro_is_enabled: false,
  })
  const integrationStatus = await getIntegrationStatus(db)
  const model = await getModel(db, modelId)
  if (!model) {
    throw new Error('Model not found')
  }
  const profile = await getModelProfile(db, modelId)
  const supportsTools = model.toolUsage !== 0
  const sourceCollector: SourceMetadata[] = []
  const toolCallCache: ToolCallCache = new Map()
  const availableTools = supportsTools
    ? await getAvailableTools(httpClient, sourceCollector, { settings, integrationStatus })
    : []
  const appToolset = createToolset(availableTools, toolCallCache)
  const merged = supportsTools
    ? await mergeMcpTools(appToolset, mcpClients, reconnectClient)
    : { toolset: appToolset, summary: undefined, mcpTools: undefined }

  const integrationStatuses = [
    integrationStatus.googleConnected && !integrationStatus.googleEnabled ? 'GOOGLE_DISABLED' : null,
    integrationStatus.microsoftConnected && !integrationStatus.microsoftEnabled ? 'MICROSOFT_DISABLED' : null,
    settings.integrationsDoNotAskAgain ? 'PROMPTS_DISABLED' : null,
  ].filter((status): status is string => status !== null)
  const prompt = createPromptParts({
    modelName: model.name,
    profile,
    modeName: modeName ?? null,
    preferredName: settings.preferredName,
    location: {
      name: settings.locationName,
      lat: settings.locationLat ? parseFloat(settings.locationLat) : undefined,
      lng: settings.locationLng ? parseFloat(settings.locationLng) : undefined,
    },
    localization: {
      distanceUnit: settings.distanceUnit,
      temperatureUnit: settings.temperatureUnit,
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      currency: settings.currency,
    },
    integrationStatus: integrationStatuses.length > 0 ? integrationStatuses.join(', ') : 'READY',
    modeSystemPrompt,
    mcpServersSummary: merged.summary,
  })

  return {
    model,
    profile,
    supportsTools,
    sourceCollector,
    toolset: merged.toolset,
    mcpToolsMetadata: merged.mcpTools,
    stableSystemPrompt: prompt.stablePrompt,
    systemPrompt: prompt.fullPrompt,
  }
}

export const aiFetchStreamingResponse = async ({
  init,
  modelId,
  modeSystemPrompt,
  modeName,
  mcpClients,
  reconnectClient,
  httpClient,
  getProxyFetch,
}: AiFetchStreamingResponseOptions) => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const abortSignal: AbortSignal | undefined = options.signal ?? undefined
  const { messages } = body as { messages: ThunderboltUIMessage[]; id: string }

  // The chat instance saves the user message via `saveMessages` before
  // invoking the adapter — see `src/chats/chat-instance.ts`. By the time we
  // reach this function the user turn is already persisted.

  const db = getDb()
  const { model, profile, supportsTools, sourceCollector, toolset, mcpToolsMetadata, systemPrompt } =
    await prepareAiRequestConfig({
      modelId,
      modeSystemPrompt,
      modeName,
      mcpClients,
      reconnectClient,
      httpClient,
    })
  if (!supportsTools) {
    console.log('Model does not support tools, skipping tool setup')
  }

  const activeNudges = getNudgeMessagesFromProfile(profile, modeName)

  try {
    const baseModel = await createModel(model, getProxyFetch)

    const wrappedModel = wrapLanguageModel({
      providerId: model.provider,
      model: baseModel,
      middleware: [
        extractReasoningMiddleware({
          tagName: 'think',
          startWithReasoning: Boolean(model.startWithReasoning),
        }),
      ],
    })

    const modelTemperature = profile?.temperature ?? inferenceDefaults.temperature
    const maxSteps = profile?.maxSteps ?? inferenceDefaults.maxSteps
    const maxAttempts = profile?.maxAttempts ?? inferenceDefaults.maxAttempts
    const nudgeThreshold = profile?.nudgeThreshold ?? inferenceDefaults.nudgeThreshold

    // Build provider options from profile + per-model DB settings
    // Uses vendor (actual model maker like 'mistral') for provider options key since the
    // backend recognizes vendor-specific options. Falls back to provider for user-created models.
    // See: https://github.com/vllm-project/vllm/issues/9019
    const providerOptionsKey = model.vendor ?? model.provider
    const rawOptions = {
      ...(model.supportsParallelToolCalls === 0 && { parallelToolCalls: false }),
      // OpenAI vendor models require systemMessageMode: 'developer' for Chat Completions API.
      // This is a transport-level requirement (not model tuning), so it's hardcoded as a baseline
      // rather than relying solely on the profile — custom OpenAI models may not have a profile.
      ...(model.vendor === 'openai' && { systemMessageMode: 'developer' as const }),
      ...profile?.providerOptions,
    }
    const providerOptions = Object.keys(rawOptions).length > 0 ? { [providerOptionsKey]: rawOptions } : undefined

    /**
     * Run a single streamText attempt and return the result along with metadata
     */
    const runStreamText = (inputMessages: Awaited<ReturnType<typeof convertToModelMessages>>) => {
      return streamText({
        temperature: modelTemperature,
        model: wrappedModel,
        system: systemPrompt,
        messages: inputMessages,
        tools: supportsTools ? (toolset as ToolSet) : undefined,
        stopWhen: stepCountIs(maxSteps),
        providerOptions,

        // Re-pace the model's text/reasoning deltas to a steady word-by-word
        // cadence (claude.ai-style fluid streaming) instead of surfacing whole
        // provider/network chunks as large jumps. smoothStream only affects
        // delivery timing — tool calls, step boundaries, and onFinish are
        // untouched — and drains any buffered text fully before the stream ends.
        // `detectStreamChunk` keeps latin word-by-word but bounds space-free runs
        // (CJK, URLs, minified JSON) so they stream instead of buffering to the end.
        experimental_transform: smoothStream({ chunking: detectStreamChunk, delayInMs: smoothStreamWordDelayMs }),

        prepareStep: ({ steps, stepNumber, messages: stepMessages }) => {
          if (isFinalStep(steps.length, maxSteps)) {
            console.info(`Final step ${stepNumber} - telling model to wrap it up...`)
          }
          return buildStepOverrides({
            steps,
            messages: stepMessages,
            systemPrompt,
            profile,
            maxSteps,
            nudgeThreshold,
            activeNudges,
          })
        },

        abortSignal,
        onStepFinish: (step) => {
          console.info('step', {
            text: step.text,
            finishReason: step.finishReason,
            toolCallCount: step.toolCalls?.length || 0,
          })

          // When a step includes tool calls, log their names and arguments for easier debugging
          step.toolCalls?.forEach((call, idx) => {
            console.groupCollapsed(`Tool call #${idx + 1}: ${call.toolName}`)
            console.log('Arguments:', call)
            console.groupEnd()
          })
        },
        onFinish: (finish) => {
          console.info('finish', {
            text: finish.text,
            finishReason: finish.finishReason,
            toolCallCount: finish.toolCalls?.length || 0,
            usage: finish.totalUsage,
          })
        },
        onError: (error) => {
          console.error('streamText error', error)
        },

        // Handle malformed tool calls from models with weaker tool-calling capabilities
        experimental_repairToolCall: async ({ toolCall, error }) => {
          // Don't attempt to repair calls to non-existent tools
          if (NoSuchToolError.isInstance(error)) {
            console.warn(`Tool "${toolCall.toolName}" does not exist, skipping`)
            return null
          }

          // Log invalid tool arguments and skip the call
          if (InvalidToolInputError.isInstance(error)) {
            console.warn(`Invalid arguments for tool "${toolCall.toolName}": ${error.message}`)
            return null
          }

          // For other errors, skip the tool call
          console.warn('Tool call error for "%s":', toolCall.toolName, error)
          return null
        },
      })
    }

    // Use createUIMessageStream to handle retries
    // Following the official SDK pattern for multi-step streams:
    // - First stream: sendFinish: false (in case we need to continue)
    // - Continuation stream: sendStart: false (continues same message)
    // Skills v1 §4: resolve slash tokens in the most recent user message
    // into ephemeral system messages. Re-resolution happens on every send /
    // regenerate so the model sees the user's *current* skill library, not
    // a snapshot from when the message was originally typed.
    //
    // Skills v1 §OQ6: skills are intentionally available in *every* mode
    // (Chat, Search, Research). There's no per-mode gating here — a skill
    // is text injection, not a tool, and modes that disagree on tools
    // still agree on text. If a future mode wants to exclude skills it'd
    // need an explicit `noSkills` flag on the mode definition.
    //
    // The composer (`chat-prompt-input.tsx`) uses the same helpers to size
    // the context-overflow estimate so the budget and the actual prepend
    // stay in lockstep.
    const lastUserText = extractLastUserText(messages)
    const allSkills = await getAllSkills(db)
    const instructionBySlug = new Map<string, string>()
    for (const skill of allSkills) {
      if (skill.enabled === 1 && skill.name && skill.instruction) {
        instructionBySlug.set(skill.name, skill.instruction)
      }
    }
    const skillSystemMessages = resolveSkillTokenInstructions(lastUserText, instructionBySlug)

    // Preserve the upstream status (and detail) when surfacing an API error to
    // the client. The SDK otherwise flattens an APICallError to a bare "Bad
    // Request", hiding the status code the retry and attachment-remediation
    // layers need to classify it. Serialized as JSON so the client can parse it
    // back out (see `getErrorStatusCode`). Applied to every stream that can
    // surface the error — both `toUIMessageStream` calls and the outer stream.
    const serializeStreamError = (error: unknown): string => {
      if (APICallError.isInstance(error)) {
        return JSON.stringify({
          error: error.responseBody ?? error.message,
          status: error.statusCode,
          isRetryable: error.isRetryable,
        })
      }
      // A provider that can't serialize a part throws this client-side, before
      // any HTTP call — so there's no status to read. It's only a *content*
      // rejection (and only then worth attachment remediation) when the
      // unsupported functionality is a file part / media type; other unsupported
      // features (tools, structured output, reasoning) are just non-retryable and
      // must NOT be tagged 422, or they'd masquerade as a fixable attachment.
      if (UnsupportedFunctionalityError.isInstance(error)) {
        const isFilePart = /file part|media type/i.test(`${error.functionality} ${error.message}`)
        return JSON.stringify({ error: error.message, status: isFilePart ? 422 : undefined, isRetryable: false })
      }
      return error instanceof Error ? error.message : String(error)
    }

    // Surface the user's persisted ask-widget responses (stored in each
    // assistant message's cache) so the model can refer back to what the user
    // chose or wrote without asking them to re-enter it. Reading every
    // assistant message's cache only pays off when an ask widget was actually
    // rendered, so guard on the tag — conversations without one (the common
    // case) skip the per-message DB reads entirely.
    const conversationHasAsk = messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.parts.some((part) => part.type === 'text' && part.text.includes('<widget:ask')),
    )
    const askEntries = conversationHasAsk
      ? (
          await Promise.all(
            messages
              .filter((message) => message.role === 'assistant')
              .map(async (message) => {
                const stored = await getMessage(db, message.id)
                return stored?.cache ? collectAskEntriesFromCache(stored.cache as Record<string, unknown>) : []
              }),
          )
        ).flat()
      : []
    const askResponsesNote = formatAskResponsesNote(askEntries)
    const systemNotes = [...skillSystemMessages, ...(askResponsesNote ? [askResponsesNote] : [])]

    const stream = createUIMessageStream({
      generateId: uuidv7,
      onError: serializeStreamError,
      execute: async ({ writer }) => {
        // Hydrate reference-only PDF attachments into AI SDK file parts (bytes
        // read from IndexedDB) so the model receives them. Only the reference is
        // persisted/synced; the bytes are inlined here, in-flight to the model.
        // Quote parts are likewise flattened to Markdown blockquote text parts.
        const baseMessages = await convertToModelMessages(
          hydrateQuotesAsText(await hydrateAttachmentsAsFileParts(messages)),
        )
        let currentMessages: typeof baseMessages = [
          ...systemNotes.map((content) => ({ role: 'system' as const, content })),
          ...baseMessages,
        ]
        let attemptNumber = 1
        let isRetry = false
        // Track tool calls across ALL attempts — a retry may produce no tool calls
        // but the data from attempt 1's tools is still there to synthesize
        let anyAttemptHadToolCalls = false

        while (attemptNumber <= maxAttempts) {
          const result = runStreamText(currentMessages)
          const messageMetadata = createMessageMetadata(modelId, sourceCollector, mcpToolsMetadata)

          // If this is not the last possible attempt, we need to check for empty response
          if (attemptNumber < maxAttempts) {
            // Merge the stream without finish event (in case we need to retry)
            writer.merge(
              result.toUIMessageStream<ThunderboltUIMessage>({
                sendReasoning: true,
                messageMetadata,
                sendFinish: false,
                onError: serializeStreamError,
              }),
            )

            // Wait for the stream to complete to check the result
            const response = await result.response
            const totalText = extractTextFromMessages(response.messages)
            const hadToolCalls = hasToolCalls(response.messages)
            anyAttemptHadToolCalls = anyAttemptHadToolCalls || hadToolCalls

            // If we got a non-empty response, we're done - send finish event
            if (totalText.trim().length > 0) {
              writer.write({ type: 'finish' })
              return
            }

            // Empty response detected - retry if any attempt gathered tool data
            if (shouldRetry(totalText, anyAttemptHadToolCalls, attemptNumber, maxAttempts)) {
              // Escalate urgency on later retries
              const retryNudge =
                attemptNumber >= maxAttempts - 1
                  ? `${activeNudges.retry} This is your final retry — you must produce a non-empty response.`
                  : activeNudges.retry

              console.info(`Empty response detected, retrying (attempt ${attemptNumber + 1}/${maxAttempts})...`)
              currentMessages = [
                ...currentMessages,
                ...response.messages,
                { role: 'user' as const, content: retryNudge },
              ]

              isRetry = true
              attemptNumber++
              continue
            }

            // Empty response with no tool calls across any attempt - send finish event and return
            writer.write({ type: 'finish' })
            return
          }

          // Last attempt - continue same message if retry, otherwise normal
          writer.merge(
            result.toUIMessageStream<ThunderboltUIMessage>({
              sendReasoning: true,
              messageMetadata,
              ...(isRetry && { sendStart: false }),
              onError: serializeStreamError,
            }),
          )
          return
        }
      },
    })

    return createUIMessageStreamResponse({ stream })
  } catch (error) {
    console.error('aiFetchStreamingResponse error', error)
    const status =
      (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status
    return new Response(JSON.stringify({ error: (error as Error).message, status }), {
      status: status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
