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
 *   - **Anthropic models** run on the in-browser Pi {@link AgentHarness}
 *     (`shared/agent-core`): a real coding agent (bash/read/write/edit over an
 *     OPFS-backed ZenFS sandbox) whose LLM HTTP flows through the app's proxy
 *     fetch. Its Pi event stream is translated to the AI SDK v5 UI message
 *     stream by `piHarnessToUiMessageStream`. The engine is `import()`-ed lazily
 *     (see `fetchViaHarness`) so its ~8MB stays off the chat entry chunk.
 *   - **Every other provider** (tinfoil, thunderbolt-proxy, openai, custom, …)
 *     stays on the legacy `aiFetchStreamingResponse` pipeline. The Pi anthropic
 *     model is the only engine wired so far; this gate is the explicit seam for
 *     migrating the rest later.
 *
 * The harness is prompted with the latest user turn; prior turns are seeded into
 * its session as history (`buildAppHarness({ history })`) so the agent has
 * multi-turn context. Side-effecting tool calls (`bash`/`write`/`edit`/MCP) are
 * gated on the chat layer's permission dialog; read-only `read` auto-allows.
 *
 * No ACP handshake either way; `capabilities` is null. The harness is built per
 * `fetch` (in-process, no wire), so `ensureSession`/`disconnect` are no-ops —
 * there is no persistent connection or session to warm or tear down.
 */

import { aiFetchStreamingResponse, mergeMcpTools } from '@/ai/fetch'
import type { Agent, AgentAdapter, AgentAdapterContext } from '@/types/acp'
import type { ThunderboltUIMessage } from '@/types'
import type { SeedTurn } from '@shared/agent-core'
import type { PermissionOption, RequestPermissionResponse, ToolKind } from '@agentclientprotocol/sdk'
import type { ThinkingLevel, ToolCallEvent, ToolCallResult } from '@earendil-works/pi-agent-core'

/** Production injection point — production binds to `aiFetchStreamingResponse`. */
export type AiFetchStreamingResponseFn = typeof aiFetchStreamingResponse

export type BuiltInAdapterOptions = {
  /** Inject for tests so we don't touch the AI SDK / DB / settings stack. Also
   *  the engine for every non-Pi provider (tinfoil/thunderbolt-proxy/openai/…). */
  aiFetch?: AiFetchStreamingResponseFn
}

/** Reasoning depth handed to the harness. Fixed for now — deriving it from the
 *  model profile is a follow-up (see the adapter's gap notes). */
const defaultThinkingLevel: ThinkingLevel = 'medium'

/** The two choices we surface for a built-in tool-call permission prompt.
 *  Stable ids so the response can be mapped back to allow/deny by kind. */
const permissionOptions: readonly PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

/** Pi tools that run unguarded — pure reads with no side effects. Mirrors the
 *  CLI's gate (`cli/src/agent/permissions.ts`): only `read` auto-allows;
 *  `bash`/`write`/`edit` and every MCP tool still prompt. Prompting on reads is
 *  noise, and the legacy built-in path never prompted at all. */
const readOnlyTools = new Set<string>(['read'])

/** Map a Pi coding-tool name to the closest ACP {@link ToolKind} so the
 *  permission dialog renders a sensible label. Unknown (e.g. MCP) tools fall
 *  back to `other`. */
const toToolKind = (toolName: string): ToolKind => {
  switch (toolName) {
    case 'bash':
      return 'execute'
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    default:
      return 'other'
  }
}

/** Translate the user's permission response into a Pi `tool_call` hook result.
 *  A cancelled prompt or a reject-kind selection blocks the tool (Pi encodes a
 *  blocked call as an error tool result); anything else allows it. */
const toToolCallResult = (response: RequestPermissionResponse): ToolCallResult | undefined => {
  const { outcome } = response
  if (outcome.outcome === 'cancelled') {
    return { block: true, reason: 'Tool call was not approved.' }
  }
  const selected = permissionOptions.find((option) => option.optionId === outcome.optionId)
  if (selected?.kind.startsWith('reject')) {
    return { block: true, reason: 'Tool call was rejected.' }
  }
  return undefined
}

/** The latest user turn to prompt with, plus the prior turns to seed as history. */
type PreparedConversation = {
  /** Prior conversation turns, oldest first, seeded into the harness session. */
  readonly history: SeedTurn[]
  /** The latest user turn's text, used to start the run (skill-prefixed). */
  readonly prompt: string
}

/** Concatenate a UI message's text parts (dropping tool/reasoning/file parts). */
const messageText = (message: ThunderboltUIMessage): string =>
  message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

/** Reduce a UI message to a seed turn, dropping non-conversational roles
 *  (`system`) and content-less turns (e.g. an assistant turn that only ran tools). */
const toTurn = (message: ThunderboltUIMessage): SeedTurn[] => {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return []
  }
  const text = messageText(message)
  return text.length > 0 ? [{ role: message.role, text }] : []
}

/** Collapse consecutive same-role turns into one (joining their text). The seeded
 *  transcript must strictly alternate: Anthropic rejects two same-role messages in
 *  a row and Pi's `convertToLlm` does not guard it, so dropping a content-less
 *  assistant turn (or a thread that already has same-role runs) must not leak two
 *  user/two assistant messages back-to-back. */
const coalesceTurns = (turns: readonly SeedTurn[]): SeedTurn[] =>
  turns.reduce<SeedTurn[]>((acc, turn) => {
    const prev = acc.at(-1)
    if (prev && prev.role === turn.role) {
      acc[acc.length - 1] = { role: turn.role, text: `${prev.text}\n\n${turn.text}` }
      return acc
    }
    acc.push(turn)
    return acc
  }, [])

/** Split the AI SDK request body into the latest user prompt and the prior turns
 *  to seed as multi-turn history. The chat transport posts the full
 *  `{ messages: ThunderboltUIMessage[], id }`; the transcript is reduced to
 *  alternating text turns whose trailing entry is always the latest user turn —
 *  that becomes the prompt (optionally skill-prefixed), and everything before it is
 *  seeded as history so the agent remembers the conversation. */
const prepareConversation = (init: RequestInit, skillInstructions: string[] | undefined): PreparedConversation => {
  if (typeof init.body !== 'string') {
    throw new Error('Built-in adapter expects a string body on init')
  }
  const { messages } = JSON.parse(init.body) as { messages: ThunderboltUIMessage[] }
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (lastUserIndex === -1) {
    throw new Error('Built-in adapter: no user message in request body')
  }
  const turns = coalesceTurns([
    ...messages.slice(0, lastUserIndex).flatMap(toTurn),
    { role: 'user', text: messageText(messages[lastUserIndex]) },
  ])
  const promptTurn = turns[turns.length - 1]
  const history = turns.slice(0, -1)
  const prompt =
    skillInstructions && skillInstructions.length > 0
      ? `${skillInstructions.join('\n\n')}\n\n${promptTurn.text}`
      : promptTurn.text
  return { history, prompt }
}

/** Resolve to a cancelled outcome when `signal` aborts. Raced against the
 *  permission dialog so stopping generation mid-prompt settles the harness's
 *  pending tool-call hook instead of leaving it awaiting a dialog that will
 *  never be answered (which would dangle the aborted run). */
const cancelledOnAbort = (signal: AbortSignal): Promise<RequestPermissionResponse> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ outcome: { outcome: 'cancelled' } })
      return
    }
    signal.addEventListener('abort', () => resolve({ outcome: { outcome: 'cancelled' } }), { once: true })
  })

/** Run the built-in request on the in-browser Pi harness and return its stream
 *  as the AI SDK UI message stream `Response`. */
const fetchViaHarness = async (init: RequestInit, context: AgentAdapterContext): Promise<Response> => {
  // Sanctioned route-splitting exception (CLAUDE.md "Route-level Code Splitting").
  // The Pi engine (`pi-*`, `zenfs`, `just-bash`, `@anthropic-ai/sdk` — ~8MB) must
  // NOT sit in the chat entry chunk on the critical landing path. This dynamic
  // import keeps it in a separate async chunk that loads only when a built-in
  // Anthropic agent actually runs; the legacy path's imports stay static.
  const { buildAppHarness, piHarnessToUiMessageStream, toPiAgentTools } = await import('@shared/agent-core')

  const { history, prompt } = prepareConversation(init, context.skillInstructions)

  // The thread's MCP servers become Pi tools (namespaced `<server>_<tool>`), reusing
  // the legacy pipeline's merge/prefix logic. Only tool-capable models reach here —
  // the harness always adds the four coding tools, so no-tools models route to legacy.
  const { toolset } = await mergeMcpTools({}, context.mcpClients, context.reconnectClient)
  const tools = await toPiAgentTools(toolset)

  const harness = await buildAppHarness({
    apiKey: context.selectedModel.apiKey ?? '',
    fetch: context.getProxyFetch(),
    modelId: context.selectedModel.model,
    systemPrompt: context.selectedMode.systemPrompt ?? '',
    thinkingLevel: defaultThinkingLevel,
    tools,
    history,
  })

  // Gate side-effecting tool calls on the chat layer's permission dialog; read-only
  // tools auto-allow (no prompt). Without a `requestPermission` sink the hook is
  // left unregistered so every tool auto-runs.
  const { requestPermission } = context
  const signal = init.signal
  if (requestPermission) {
    harness.on('tool_call', async (event: ToolCallEvent) => {
      if (readOnlyTools.has(event.toolName)) {
        return undefined
      }
      const ask = requestPermission({
        sessionId: context.threadId,
        toolCall: {
          toolCallId: event.toolCallId,
          title: event.toolName,
          kind: toToolKind(event.toolName),
          rawInput: event.input,
          status: 'pending',
        },
        options: [...permissionOptions],
      })
      const response = signal ? await Promise.race([ask, cancelledOnAbort(signal)]) : await ask
      return toToolCallResult(response)
    })
  }

  return new Response(
    piHarnessToUiMessageStream(harness, async () => {
      await harness.prompt(prompt)
      await harness.waitForIdle()
    }),
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

  // Route tool-capable Anthropic models to the in-browser Pi harness; everything
  // else (other providers, or a no-tools Anthropic model the harness can't honor
  // since it always activates coding tools) stays on the legacy pipeline.
  const fetch = (init: RequestInit, context: AgentAdapterContext): Promise<Response> =>
    context.selectedModel.provider === 'anthropic' && context.selectedModel.toolUsage !== 0
      ? fetchViaHarness(init, context)
      : fetchViaLegacyPipeline(init, context)

  return {
    agent,
    capabilities: null,
    fetch,
    // No ACP session and no persistent harness — the engine is built per fetch.
    ensureSession: async () => {},
    disconnect: () => {},
  }
}
