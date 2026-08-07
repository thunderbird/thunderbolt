/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The per-connection ACP {@link Agent} fronting server-owned session runtimes.
 *
 * Unlike the CLI's `createHarnessAgent` (whose sessions die with the
 * connection), this agent only mediates: sessions live in the process-global
 * {@link SessionRegistry}, and a connection is just one observer of them.
 * Closing the socket detaches this connection's observers — in-flight turns keep
 * running, and any other connection watching the same session keeps receiving
 * updates (see `session-runtime.ts`).
 *
 * The client, not the runner, picks what runs: `session/new`, `session/resume`
 * and `session/prompt` each carry a run spec (model id + reasoning depth) in
 * `_meta`, and a missing or malformed one is an invalid-params error rather than
 * a runner-side default.
 *
 * Extension surface (contract in `shared/acp-types.ts`):
 *  - the replay method re-delivers journaled updates through this connection
 *    (before the method's response — the SDK serializes writes) and keeps it
 *    attached for live ones, reporting the current/last turn so the client can
 *    reconcile its transcript;
 *  - the await-turn method resolves when the in-flight turn ends, giving a
 *    reattached client the stop reason its dead `session/prompt` response would
 *    have carried;
 *  - the delete-session method erases a session's server-side state when its
 *    thread is deleted in the app.
 */

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
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionId,
} from '@agentclientprotocol/sdk'
import {
  detachedTurnsCapabilityMeta,
  mergeAcpMeta,
  readRunSpec,
  runnerAwaitTurnMethod,
  runnerDeleteSessionMethod,
  runnerReplayMethod,
  type RunnerAwaitTurnResponse,
  type RunnerReplayResponse,
  type RunSpec,
} from '../../shared/acp-types.ts'
import { readWireSkills, skillsCapabilityMeta } from '../../shared/agent-core/skills.ts'
import type { ReplayMode, SessionRegistry, SessionRuntime, UpdateSink } from './session-runtime.ts'
import type { AuthorizedConnection } from './auth.ts'

export const runnerVersion = '0.1.0'

/** ACP `agentInfo.name`. Names the execution target, not a product an end user
 *  picks — the runner hosts the built-in agent transparently. */
const runnerAgentName = 'thunderbolt-runner'

/** Flatten an ACP prompt's content blocks into plain text (only text blocks are
 *  advertised in `promptCapabilities`, so nothing else legitimately arrives). */
const promptText = (blocks: ContentBlock[]): string =>
  blocks
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

/** Read the run spec a session operation must execute under. The runner has no
 *  model of its own to fall back to, so an absent or malformed spec is a client
 *  error. */
const requireRunSpec = (meta: Readonly<Record<string, unknown>> | null | undefined): RunSpec => {
  const runSpec = readRunSpec(meta)
  if (!runSpec) {
    throw RequestError.invalidParams(undefined, 'a run spec (model id and thinking level) is required in _meta')
  }
  return runSpec
}

/**
 * Build the ACP agent for one authenticated connection.
 *
 * @param conn - agent-side ACP connection (session updates flow through it)
 * @param registry - process-global session registry
 * @param connection - the authenticated user and the bearer it presented
 */
export const createRunnerAgent = (
  conn: AgentSideConnection,
  registry: SessionRegistry,
  connection: AuthorizedConnection,
): Agent => {
  const { user, bearer } = connection
  // Observers this connection registered, so close detaches exactly ours and
  // leaves every other connection watching the same session untouched.
  const sinks = new Map<SessionId, { runtime: SessionRuntime; sink: UpdateSink }>()

  // Deferred a microtask because `AgentSideConnection` invokes this factory
  // before it wires up `conn.closed` — reading it synchronously here throws.
  queueMicrotask(() => {
    void conn.closed
      .then(() => {
        for (const { runtime, sink } of sinks.values()) {
          runtime.detach(sink)
        }
        sinks.clear()
      })
      .catch(() => {})
  })

  const makeSink = (sessionId: SessionId): UpdateSink => (update) => {
    // Fire-and-forget: the SDK serializes writes, and a rejection only means
    // the client went away mid-turn — the turn itself continues detached.
    void conn.sessionUpdate({ sessionId, update }).catch(() => {})
  }

  const attach = (runtime: SessionRuntime, mode: ReplayMode) => {
    // The freshest bearer wins: model requests should ride the credential of
    // whichever connection most recently claimed the session.
    runtime.setBearer(bearer)
    const sessionId = runtime.sessionId as SessionId
    // One observer per connection per session: `session/resume` followed by a
    // replay must not register two sinks, or every update would arrive twice.
    const sink = sinks.get(sessionId)?.sink ?? makeSink(sessionId)
    const result = runtime.attach(sink, mode)
    sinks.set(sessionId, { runtime, sink })
    return result
  }

  const initialize = async (_params: InitializeRequest): Promise<InitializeResponse> => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: runnerAgentName, version: runnerVersion },
    agentCapabilities: {
      loadSession: false,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      // Both payloads share the Thunderbolt namespace, so they are merged rather
      // than spread (a spread would drop one).
      _meta: mergeAcpMeta(skillsCapabilityMeta, detachedTurnsCapabilityMeta),
    },
    authMethods: [],
  })

  const newSession = async (params: NewSessionRequest): Promise<NewSessionResponse> => {
    const runtime = await registry.create({
      userId: user.id,
      bearer,
      skills: readWireSkills(params._meta),
      runSpec: requireRunSpec(params._meta),
    })
    attach(runtime, { replay: 'none' })
    return { sessionId: runtime.sessionId }
  }

  const resumeSession = async (params: ResumeSessionRequest): Promise<ResumeSessionResponse> => {
    const runtime = await registry.resume({
      userId: user.id,
      sessionId: params.sessionId,
      bearer,
      skills: readWireSkills(params._meta),
      runSpec: requireRunSpec(params._meta),
    })
    attach(runtime, { replay: 'none' })
    return {}
  }

  const prompt = async (params: PromptRequest): Promise<PromptResponse> => {
    const runSpec = requireRunSpec(params._meta)
    // Checked before the run spec is applied, so a refused turn never leaves the
    // session rebuilt for a prompt that did not run.
    registry.requireTurnSlot(user.id)
    const runtime = await registry.requireForTurn({
      userId: user.id,
      sessionId: params.sessionId,
      bearer,
      skills: readWireSkills(params._meta),
      runSpec,
    })
    const { stopReason } = await runtime.prompt(promptText(params.prompt))
    return { stopReason }
  }

  const cancel = async (params: CancelNotification): Promise<void> => {
    const runtime = registry.require(user.id, params.sessionId)
    await runtime.cancel()
  }

  const readSessionId = (params: Record<string, unknown>): string => {
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string') {
      throw RequestError.invalidParams(undefined, 'sessionId is required')
    }
    return sessionId
  }

  const requireSessionParam = (params: Record<string, unknown>): SessionRuntime =>
    registry.require(user.id, readSessionId(params))

  const extMethod = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === runnerReplayMethod) {
      const runtime = requireSessionParam(params)
      const response: RunnerReplayResponse = attach(runtime, { replay: 'latest-turn' })
      return response
    }
    if (method === runnerAwaitTurnMethod) {
      const runtime = requireSessionParam(params)
      const response: RunnerAwaitTurnResponse = { turn: await runtime.awaitTurnEnd() }
      return response
    }
    if (method === runnerDeleteSessionMethod) {
      await registry.delete(user.id, readSessionId(params))
      return {}
    }
    throw RequestError.methodNotFound(method)
  }

  // Transport-level bearer auth already ran before this agent exists.
  const authenticate = async (): Promise<AuthenticateResponse> => ({})

  return { initialize, newSession, resumeSession, prompt, cancel, authenticate, extMethod }
}
