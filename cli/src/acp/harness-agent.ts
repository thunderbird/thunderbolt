/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The built-in Pi coding agent, exposed as an ACP {@link Agent}.
 *
 * This is the server half of `thunderbolt acp serve`: it implements the ACP
 * `Agent` interface on top of {@link buildHarness}, so the iroh/wss bridge can
 * expose OUR coding agent to a remote ACP client (the bridge otherwise only
 * proxies external stdio ACP agents). Each `session/new` builds its own harness
 * bound to server's trusted launch directory; harness run events stream back as
 * ACP `session/update` notifications via {@link createHarnessToAcpTranslator},
 * and tool-permission requests round-trip to client.
 *
 * Sessions persist to disk on the bridge machine (via {@link SessionStore}), so a
 * reconnect can rebuild the agent's execution context with `session/resume`
 * (advertised `sessionCapabilities.resume`). We use `resume` — which explicitly
 * does NOT replay history — rather than `loadSession`, because our app renders
 * the transcript from PowerSync and must not receive a replay; `loadSession`
 * stays unadvertised (`loadSession: false`). The live `Map<SessionId, Session>`
 * below remains the per-connection registry, now hydrated from disk on resume.
 */

import { realpath } from 'node:fs/promises'
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type {
  Agent,
  AgentSideConnection,
  AuthenticateResponse,
  CancelNotification,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  RequestPermissionOutcome,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionId,
} from '@agentclientprotocol/sdk'
import type {
  AgentHarnessEvent,
  Session as PiSession,
  ToolCallEvent,
  ToolCallResult,
} from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isReadOnlyAgentTool, resolveToolPermission } from '../../../shared/agent-tool-permissions.ts'
import { cliVersion } from '../cli.ts'
import { buildHarness } from '../agent/harness.ts'
import type { HarnessConfig, ServeConfig } from '../agent/types.ts'
import { isExistingPathInWorkspace } from '../agent/workspace-jail.ts'
import { createHarnessToAcpTranslator, toAcpStopReason, toToolKind } from './harness-to-acp.ts'
import type { SessionStore } from './session-store.ts'

/**
 * The slice of the Pi {@link AgentHarness} the ACP agent drives. A hand-written
 * surface (rather than the full harness) keeps it tiny and lets a test supply a
 * fake without reconstructing the harness's generic `on`/`subscribe` shapes — so
 * the round-trip can be exercised with no API key.
 */
export type ServeHarness = {
  /** Subscribe to run events; returns an unsubscribe function. */
  subscribe: (listener: (event: AgentHarnessEvent) => void) => () => void
  /** Register the pre-execution permission gate for tool calls. */
  registerToolCallGate: (handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined>) => void
  /** Run one prompt turn, resolving with the final assistant message. */
  prompt: (text: string) => Promise<AssistantMessage>
  /** Resolve once the harness has settled after a prompt. */
  waitForIdle: () => Promise<void>
  /** Abort the in-flight turn (drives the ACP `cancelled` stop reason). */
  abort: () => Promise<void>
}

/** Builds a {@link ServeHarness} for one session, paired with its teardown.
 *  `session` is the disk-backed Pi session to run on (new or resumed).
 *  Injectable so tests can swap in a fake. */
export type BuildServeHarness = (
  config: HarnessConfig,
  session: PiSession,
) => Promise<{ harness: ServeHarness; dispose: () => Promise<void> }>

/** Production builder: adapts the real {@link buildHarness} to the narrow
 *  {@link ServeHarness} surface the agent needs. */
const defaultBuildServeHarness: BuildServeHarness = async (config, session) => {
  const { harness, dispose } = await buildHarness(config, session)
  return {
    harness: {
      subscribe: (listener) => harness.subscribe(listener),
      registerToolCallGate: (handler) => {
        harness.on('tool_call', handler)
      },
      prompt: (text) => harness.prompt(text),
      waitForIdle: () => harness.waitForIdle(),
      abort: async () => {
        await harness.abort()
      },
    },
    dispose,
  }
}

/** A live ACP session: its harness, the run-event subscription feeding the ACP
 *  client, and a teardown that releases the harness's execution environment. */
type Session = {
  readonly harness: ServeHarness
  readonly unsubscribe: () => void
  readonly dispose: () => Promise<void>
}

/** Canonical UUID shape that `crypto.randomUUID()` mints for every `session/new`.
 *  A `session/resume` id is always a past mint, so a legitimate one matches; the
 *  guard exists because the resumed id is client-supplied (ACP `z.string()`) and
 *  flows into the on-disk path builder, which `path.join`s it — a crafted `..`
 *  id would escape the sessions root and overwrite an arbitrary `.jsonl`. */
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The permission choices offered to the ACP client for a gated tool call.
 *  `allow-always` allows that tool for the rest of the session; the others are
 *  one-shot. Mirrors the interactive gate's allow-once/allow-session/deny. */
const permissionOptions: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

/** Flatten an ACP prompt's content blocks into the plain text the harness takes.
 *  Only text blocks are kept — image/audio/resource blocks are not advertised in
 *  `promptCapabilities`, so a spec-respecting client never sends them. */
const promptText = (blocks: ContentBlock[]): string =>
  blocks
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

/**
 * Map the client's permission decision to a Pi {@link ToolCallResult}.
 * `undefined` lets the tool run; a blocking result stops it with a reason the
 * model sees. `allow-always` additionally remembers the tool for the session.
 *
 * @param outcome - the client's `session/request_permission` outcome
 * @param toolName - the tool being decided on
 * @param sessionAllowed - the per-session set of tools allowed without re-asking
 */
const toToolCallResult = (
  outcome: RequestPermissionOutcome,
  toolName: string,
  sessionAllowed: Set<string>,
): ToolCallResult | undefined => {
  const decision = resolveToolPermission(outcome, permissionOptions)
  if (decision === 'allow-always') {
    if (toolName !== 'read') sessionAllowed.add(toolName)
    return undefined
  }
  if (decision === 'allow-once') return undefined
  if (outcome.outcome === 'cancelled') return { block: true, reason: 'permission request cancelled' }
  return { block: true, reason: `user rejected ${toolName}` }
}

/**
 * Register tool-permission gate. Reads auto-run only when their real path is
 * inside workspace, including in `yolo` mode. Outside reads always prompt;
 * mutating tools prompt unless `yolo` or session-allowed.
 */
const attachAcpPermissionGate = (
  harness: ServeHarness,
  conn: AgentSideConnection,
  sessionId: SessionId,
  yolo: boolean,
  workspaceRoot: string,
): void => {
  const sessionAllowed = new Set<string>()

  harness.registerToolCallGate(async ({ toolCallId, toolName, input }) => {
    if (toolName === 'webfetch') return undefined
    if (isReadOnlyAgentTool(toolName)) {
      const path =
        typeof input === 'object' && input !== null && 'path' in input && typeof input.path === 'string'
          ? input.path
          : undefined
      if (path && (await isExistingPathInWorkspace(workspaceRoot, path))) return undefined
    } else if (yolo || sessionAllowed.has(toolName)) {
      return undefined
    }

    const { outcome } = await conn.requestPermission({
      sessionId,
      options: permissionOptions,
      toolCall: { toolCallId, title: toolName, kind: toToolKind(toolName), rawInput: input, status: 'pending' },
    })
    return toToolCallResult(outcome, toolName, sessionAllowed)
  })
}

/**
 * Build the ACP {@link Agent} that fronts the built-in Pi harness for one
 * connection. All sessions for the connection share `config` (model, thinking,
 * yolo) and connection lifetime; each session gets its own harness bound to
 * server-owned workspace root. Sessions dispose when connection closes.
 *
 * @param conn - the agent-side ACP connection (used to push updates + ask permission)
 * @param config - the resolved serve configuration
 * @param store - disk-backed session store keyed by ACP `sessionId` (new + resume)
 * @param buildServeHarness - harness builder; injected by tests, defaults to the real one
 */
export const createHarnessAgent = (
  conn: AgentSideConnection,
  config: ServeConfig,
  store: SessionStore,
  buildServeHarness: BuildServeHarness = defaultBuildServeHarness,
): Agent => {
  const sessions = new Map<SessionId, Session>()
  const trustedWorkspace = realpath(config.cwd)

  // Release every session's execution environment when the connection ends, so
  // a dropped client never leaks the harness's temp dirs / shell. Deferred a
  // microtask because `AgentSideConnection` invokes this factory *before* it
  // wires up `conn.closed`, which would otherwise throw when read here. Disposes
  // independently (one failure can't strand the rest) and logs any failure.
  queueMicrotask(() => {
    void conn.closed
      .then(async () => {
        const open = [...sessions.values()]
        sessions.clear()
        const outcomes = await Promise.allSettled(
          open.map(async (session) => {
            session.unsubscribe()
            await session.dispose()
          }),
        )
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            process.stderr.write(`⚡ acp serve: session dispose failed: ${String(outcome.reason)}\n`)
          }
        }
      })
      .catch((err) => {
        process.stderr.write(
          `⚡ acp serve: connection cleanup error: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
  })

  const requireSession = (sessionId: SessionId): Session => {
    const session = sessions.get(sessionId)
    if (!session) throw RequestError.invalidParams(undefined, `unknown session '${sessionId}'`)
    return session
  }

  const initialize = async (_params: InitializeRequest): Promise<InitializeResponse> => ({
    // We implement exactly one protocol version, so we always answer with it —
    // the only version we could honestly negotiate. A client that can't speak it
    // disconnects (per ACP initialization).
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'thunderbolt', version: cliVersion },
    agentCapabilities: {
      // We do not replay history (the app renders from PowerSync), so we
      // advertise `resume` — no-replay context restore — not `loadSession`.
      loadSession: false,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    authMethods: [],
  })

  /** Per-session harness config rooted at server-owned launch directory. */
  const harnessConfigFor = (workspaceRoot: string): HarnessConfig => ({
    model: config.model,
    cwd: workspaceRoot,
    workspaceRoot,
    yolo: config.yolo,
    thinking: config.thinking,
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    announceModel: true,
  })

  /** Build the harness on `session`, wire its run events + permission gate to the
   *  ACP connection, and register it live. Shared by new and resume — the only
   *  difference between them is which {@link PiSession} is handed in. */
  const activate = async (
    sessionId: SessionId,
    workspaceRoot: string,
    session: PiSession,
    phase: string,
  ): Promise<void> => {
    const { harness, dispose } = await buildServeHarness(harnessConfigFor(workspaceRoot), session)

    // If the client vanished while the harness was being built, the cleanup
    // microtask already ran against a map without this session — dispose now so
    // the freshly-built harness can't leak its temp dirs / shell.
    if (conn.signal.aborted) {
      await dispose()
      throw RequestError.internalError(undefined, `connection closed during ${phase}`)
    }

    const translator = createHarnessToAcpTranslator((update) => {
      // Fire-and-forget: the SDK serializes writes on one queue, so updates
      // emitted in order arrive in order. A rejection means the client went away
      // mid-turn (the stream closed) — benign teardown, not an error to surface —
      // so swallow it to avoid an unhandled rejection; the connection close is the
      // real signal that ends the run.
      void conn.sessionUpdate({ sessionId, update }).catch(() => {})
    })
    const unsubscribe = harness.subscribe((event) => translator.handle(event))
    attachAcpPermissionGate(harness, conn, sessionId, config.yolo, workspaceRoot)

    // Re-activating a live id (e.g. a repeated session/resume on one connection)
    // replaces the entry — tear down the prior harness + subscription first so it
    // can't leak its execution env or double-append the shared disk log.
    const previous = sessions.get(sessionId)
    sessions.set(sessionId, { harness, unsubscribe, dispose })
    if (previous) {
      previous.unsubscribe()
      await previous.dispose()
    }
  }

  const newSession = async (_params: NewSessionRequest): Promise<NewSessionResponse> => {
    const sessionId = crypto.randomUUID()
    const workspaceRoot = await trustedWorkspace
    const session = await store.createSession(sessionId, workspaceRoot)
    await activate(sessionId, workspaceRoot, session, 'session/new')
    return { sessionId }
  }

  // Resume a prior thread on a fresh process: rehydrate the agent's execution
  // context from the on-disk log keyed by the client-supplied sessionId. No
  // history is replayed to the client (the app already rendered it from
  // PowerSync); we only re-seed the harness. Malformed ids reject at wire
  // boundary; missing logs reject so client creates new session and reseeds
  // transcript instead of accepting an empty resume.
  const resumeSession = async (params: ResumeSessionRequest): Promise<ResumeSessionResponse> => {
    // Reject a crafted id at the wire boundary before it reaches the on-disk path
    // builder — a `..` segment would let the write escape the sessions root.
    if (!sessionIdPattern.test(params.sessionId)) {
      throw RequestError.invalidParams(undefined, `invalid session id '${params.sessionId}'`)
    }
    const workspaceRoot = await trustedWorkspace
    const session = await store.openSession(params.sessionId, workspaceRoot)
    await activate(params.sessionId, workspaceRoot, session, 'session/resume')
    return {}
  }

  const prompt = async (params: PromptRequest): Promise<PromptResponse> => {
    const { harness } = requireSession(params.sessionId)
    const result = await harness.prompt(promptText(params.prompt))
    await harness.waitForIdle()
    // A failed turn resolves (it doesn't throw) with `stopReason: 'error'`, which
    // has no ACP equivalent — surface it loudly as a JSON-RPC error instead.
    if (result.stopReason === 'error') throw new Error(result.errorMessage ?? 'the model request failed')
    return { stopReason: toAcpStopReason(result.stopReason) }
  }

  const cancel = async (params: CancelNotification): Promise<void> => {
    await sessions.get(params.sessionId)?.harness.abort()
  }

  // No authentication: the transport (loopback wss / allowlisted iroh) is the
  // trust boundary, so `authenticate` is a no-op the client should never need.
  const authenticate = async (): Promise<AuthenticateResponse> => ({})

  return { initialize, newSession, resumeSession, prompt, cancel, authenticate }
}
