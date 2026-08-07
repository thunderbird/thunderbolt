/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Server-owned ACP sessions with detached (background) turns — the piece that
 * makes "close the tab, the agent keeps working" true.
 *
 * The CLI's `acp serve` scopes each session to its connection: the socket
 * closing disposes the harness and aborts the in-flight turn. Here ownership is
 * inverted. A {@link SessionRuntime} belongs to the *process*, keyed by ACP
 * `sessionId` in a {@link SessionRegistry}; WebSocket connections merely observe
 * it. A dropped connection removes that observer and nothing else — the running
 * turn continues, and every `session/update` it produces is journaled with a
 * per-session monotonically increasing `seq`. Several connections may observe
 * one session at once (two tabs, two devices), and all of them see live updates.
 *
 * Reconnection catch-up (see `shared/acp-types.ts` for the wire contract):
 * `attach` optionally replays journaled entries past a cursor through the new
 * observer before going live. The read-journal + register-observer step is
 * synchronous, so a turn streaming concurrently can never skip or double-deliver
 * an update.
 *
 * Model selection: the client owns it. Every session/turn carries a run spec
 * (model id + reasoning depth) and the runtime executes exactly that — a spec
 * change while idle rebuilds the harness over the same session log so history
 * survives, and a spec change mid-turn is an error rather than a silent
 * substitution.
 *
 * Model access: a runtime holds the bearer of the connection that last touched
 * it and authenticates every model request to the backend inference gateway
 * with it (see `gateway-model.ts`). A turn pins the bearer it started with, so
 * a reconnect mid-turn cannot swap credentials underneath a running request.
 *
 * Persistence: the Pi session entry log is disk-backed via the CLI's
 * {@link SessionStore} (JSONL under `<dataDir>/sessions`), so `session/resume`
 * rehydrates full model context even after the runtime was swept or the
 * process restarted. The journal itself is in-memory and bounded — it exists
 * for transcript catch-up, not durability; a swept session resumes with
 * context intact but nothing to replay.
 *
 * Sessions are owned by this process alone. See `README.md` for what that means
 * for scaling and deployments.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { AgentHarness } from '@earendil-works/pi-agent-core'
import { sameRunSpec, type RunnerReplayResponse, type RunnerTurnRecord, type RunSpec } from '../../shared/acp-types.ts'
import type { SkillDefinition } from '../../shared/agent-core/skills.ts'
import { createHarnessToAcpTranslator, toAcpStopReason } from '../../cli/src/acp/harness-to-acp.ts'
import { createSessionStore, type SessionStore } from '../../cli/src/acp/session-store.ts'
import { buildHarness } from '../../cli/src/agent/harness.ts'
import type { HarnessConfig } from '../../cli/src/agent/types.ts'
import { gatewayBaseUrl, type RunnerConfig } from './config.ts'
import { bindGatewayBearer } from './gateway-model.ts'
import { bindChatSurfacePrompt } from './chat-surface.ts'
import { createSourceRegistry, registerProTools } from './pro-tools.ts'
import { registerRenderHtmlTool } from './render-html-tool.ts'
import { createSessionStorage, type SessionStorage } from './storage.ts'

/** Sink a connection registers to receive live/replayed session updates. */
export type UpdateSink = (update: SessionUpdate) => void

/** Replay selector for {@link SessionRuntime.attach}. */
export type ReplayMode = { replay: 'latest-turn' } | { replay: 'none' }

/** What `attach` reports back — exactly the replay wire response, so runtime
 *  and protocol cannot drift. */
export type AttachResult = RunnerReplayResponse

/** The harness surface a runtime drives. */
export type RuntimeHarness = Pick<AgentHarness, 'subscribe' | 'prompt' | 'waitForIdle' | 'abort'>

/** A harness built for one run spec, plus the teardown releasing its execution
 *  environment. */
export type HarnessBundle = { readonly harness: RuntimeHarness; readonly dispose: () => Promise<void> }

/** Opens the harness a session executes under — once when the session opens, and
 *  again on every run-spec change. `readBearer` yields the bearer the next model
 *  request must authenticate with (see `gateway-model.ts`). */
export type OpenHarness = (runSpec: RunSpec, readBearer: () => string) => Promise<HarnessBundle>

/** One live session: harness + journal + its attached observers. */
export type SessionRuntime = {
  readonly sessionId: string
  readonly userId: string
  /** Run spec the session currently executes under. */
  runSpec: () => RunSpec
  /** Execute under `runSpec` from now on, rebuilding the harness over the same
   *  session log and workspace when it differs (journal, observers and bearer
   *  are kept). A no-op for an unchanged spec; rejects while a turn runs. */
  reopen: (runSpec: RunSpec) => Promise<void>
  /** Register an observer, optionally replaying journal entries first. */
  attach: (sink: UpdateSink, mode: ReplayMode) => AttachResult
  /** Remove one observer; the others keep receiving updates. */
  detach: (sink: UpdateSink) => void
  /** Adopt the bearer of the connection that just touched this session. */
  setBearer: (bearer: string) => void
  /** Bearer the next model request must authenticate with: the running turn's
   *  pinned one, otherwise the most recent connection's. */
  modelBearer: () => string
  /** Run one prompt turn. Rejects on model failure (parity with `acp serve`);
   *  a detached rejection is swallowed internally and recorded on the turn. */
  prompt: (text: string) => Promise<{ stopReason: StopReason }>
  /** Abort the in-flight turn, if any. */
  cancel: () => Promise<void>
  /** Resolve with the finished (or last) turn when the in-flight turn ends;
   *  immediately when idle. `null` when the session never ran one. */
  awaitTurnEnd: () => Promise<RunnerTurnRecord | null>
  turnActive: () => boolean
  /** Eligible for sweeping: no observers, no turn running, idle past TTL. */
  isIdleSince: (cutoffMs: number) => boolean
  /** Release the harness execution env. The disk session log survives. */
  dispose: () => Promise<void>
}

/** Journal retention caps. Entries are capped by count AND by approximate
 *  serialized bytes — a single tool result (`rawOutput` of a large file read)
 *  can dwarf thousands of text deltas, so counting entries alone would not
 *  bound memory. Catch-up for anything evicted is served by the persisted
 *  transcript on the client side, not the journal. The byte cap also bounds
 *  the worst-case synchronous replay burst on reattach. */
const maxJournalEntries = 50_000
const maxJournalBytes = 32 * 1024 * 1024

/** Canonical UUID shape minted by `crypto.randomUUID()` for `session/new`.
 *  Resume ids are client-supplied and flow into on-disk paths — reject
 *  anything else loudly (same guard as the CLI's harness agent). */
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** User ids come from Better Auth and also form workspace path segments. */
const safePathSegment = /^[A-Za-z0-9._-]+$/

type JournalEntry = { readonly seq: number; readonly update: SessionUpdate; readonly size: number }

const assertSafeSegment = (value: string, label: string): void => {
  if (!safePathSegment.test(value) || value === '.' || value === '..') {
    throw RequestError.invalidParams(undefined, `unsafe ${label}`)
  }
}

/** One error for "missing" and "not yours" so existence never leaks. */
const unknownSession = (sessionId: string): RequestError =>
  RequestError.invalidParams(undefined, `unknown session '${sessionId}'`)

/** Everything the registry needs to open one session's harness. Exported so
 *  tests can substitute a fake for the real one. */
export type RuntimeDeps = {
  readonly config: RunnerConfig
  readonly store: SessionStore
  readonly sessionId: string
  readonly userId: string
  readonly workspaceDir: string
  readonly skills: readonly SkillDefinition[]
  /** Whether the session's entry log already exists on disk (`session/resume`). */
  readonly existing: boolean
}

/** Binds an {@link OpenHarness} to one session. The registry's injection seam. */
export type OpenHarnessFor = (deps: RuntimeDeps) => OpenHarness

/**
 * Harness settings for one session: the client's chosen model and reasoning
 * depth, routed through the backend inference gateway, with tools jailed to the
 * session workspace.
 *
 * Exported for tests — this mapping is where a client's model choice becomes the
 * executed one.
 *
 * @param deps - the session's static placement (workspace, skills, backend)
 * @param runSpec - model id and reasoning depth the client asked for
 * @param apiKey - bearer the initial model resolution is built with; every
 *   later request re-reads it through {@link bindGatewayBearer}
 */
export const harnessConfigFor = (deps: RuntimeDeps, runSpec: RunSpec, apiKey: string): HarnessConfig => ({
  // Whatever gateway id the client sent. The gateway is the authority on which
  // ids exist, so an unknown one fails that turn loudly instead of falling back.
  model: runSpec.modelId,
  cwd: deps.workspaceDir,
  workspaceRoot: deps.workspaceDir,
  // No interactive permission gate exists in a background service. Tools are
  // confined to the per-session workspace jail (no bash — `buildHarness` omits
  // it whenever `workspaceRoot` is set), so auto-approval is the design, not a
  // shortcut.
  yolo: true,
  thinking: runSpec.thinkingLevel,
  // The backend inference gateway is OpenAI-compatible and takes the end user's
  // own app bearer as its api key; `bindGatewayBearer` keeps that key current.
  provider: 'openai-compat',
  baseUrl: gatewayBaseUrl(deps.config),
  apiKey,
  announceModel: true,
  skills: deps.skills,
})

const openHarnessFor: OpenHarnessFor = (deps) => {
  // The first open mints the entry log for `session/new`; every later one —
  // resume, and every run-spec change — reopens it, which is what keeps model
  // context across a rebuild.
  let logExists = deps.existing
  // Source numbering must survive harness rebuilds (a mid-session model change
  // reopens the harness), or `[N]` citations would restart at 1 and collide.
  const sources = createSourceRegistry()
  return async (runSpec, readBearer) => {
    await mkdir(deps.workspaceDir, { recursive: true })
    const session = logExists
      ? await deps.store.openSession(deps.sessionId, deps.workspaceDir)
      : await deps.store.createSession(deps.sessionId, deps.workspaceDir)
    logExists = true
    const { harness, dispose } = await buildHarness(harnessConfigFor(deps, runSpec, readBearer()), session)
    await registerRenderHtmlTool(harness)
    await registerProTools(harness, { backendUrl: deps.config.backendUrl, readBearer, sources })
    bindChatSurfacePrompt(harness)
    bindGatewayBearer(harness.models, readBearer)
    return { harness, dispose }
  }
}

type CreateRuntimeInputs = {
  readonly sessionId: string
  readonly userId: string
  /** Bearer of the connection creating the runtime. */
  readonly bearer: string
  /** Model and reasoning depth the session opens under. */
  readonly runSpec: RunSpec
  readonly openHarness: OpenHarness
  /** Journal retention overrides — tests exercise truncation without 50k entries. */
  readonly journalLimit?: number
  readonly journalByteLimit?: number
}

/** Assemble a runtime around its harness. Exported for tests, which pass a fake
 *  {@link OpenHarness}; production goes through {@link createSessionRegistry}. */
export const createSessionRuntime = async (inputs: CreateRuntimeInputs): Promise<SessionRuntime> => {
  const { sessionId, userId, openHarness } = inputs
  const journalLimit = inputs.journalLimit ?? maxJournalEntries
  const journalByteLimit = inputs.journalByteLimit ?? maxJournalBytes

  const journal: JournalEntry[] = []
  const observers = new Set<UpdateSink>()
  let journalBytes = 0
  let nextSeq = 1
  let lastActivityAt = Date.now()
  let currentBearer = inputs.bearer
  let currentRunSpec = inputs.runSpec

  let lastTurn: RunnerTurnRecord | null = null
  let activeTurn: { readonly record: RunnerTurnRecord; readonly bearer: string; readonly done: Promise<void> } | null =
    null

  const latestSeq = (): number => nextSeq - 1

  const touch = (): void => {
    lastActivityAt = Date.now()
  }

  // Evict from the head down to limit − limit/8 whenever a cap is crossed:
  // the hysteresis makes the O(n) splice amortized instead of per-append (a
  // capped journal that `shift()`ed every update would memmove the whole
  // array on each one).
  const trimJournal = (): void => {
    if (journal.length <= journalLimit && journalBytes <= journalByteLimit) {
      return
    }
    const targetCount = journalLimit - (journalLimit >> 3)
    const targetBytes = journalByteLimit - (journalByteLimit >> 3)
    let drop = 0
    let droppedBytes = 0
    while (drop < journal.length && (journal.length - drop > targetCount || journalBytes - droppedBytes > targetBytes)) {
      droppedBytes += journal[drop].size
      drop++
    }
    journal.splice(0, drop)
    journalBytes -= droppedBytes
  }

  const translator = createHarnessToAcpTranslator((update) => {
    // The size is approximate (serialized length, not heap bytes) but pays for
    // itself: it is the only honest way to bound tool outputs of any shape.
    const size = JSON.stringify(update).length
    journal.push({ seq: nextSeq, update, size })
    nextSeq++
    journalBytes += size
    trimJournal()
    touch()
    for (const sink of observers) {
      sink(update)
    }
  })

  const modelBearer = (): string => activeTurn?.bearer ?? currentBearer
  const subscribe = (bundle: HarnessBundle): (() => void) =>
    bundle.harness.subscribe((event) => translator.handle(event))

  let bundle = await openHarness(currentRunSpec, modelBearer)
  let unsubscribe = subscribe(bundle)

  const reopen = async (runSpec: RunSpec): Promise<void> => {
    if (sameRunSpec(currentRunSpec, runSpec)) return
    if (activeTurn) {
      throw RequestError.invalidParams(
        undefined,
        'cannot change the model or reasoning depth while a turn is running for this session',
      )
    }
    // Opened before the current harness is released, so a failing open leaves
    // the session usable on its existing spec instead of harness-less.
    const next = await openHarness(runSpec, modelBearer)
    const previous = bundle
    unsubscribe()
    bundle = next
    unsubscribe = subscribe(next)
    currentRunSpec = runSpec
    touch()
    await previous.dispose()
  }

  const resolveCursor = (mode: ReplayMode): number | null => {
    if (mode.replay === 'latest-turn') {
      const turn = activeTurn?.record ?? lastTurn
      return turn ? turn.startSeq - 1 : null
    }
    return null
  }

  const attach = (sink: UpdateSink, mode: ReplayMode): AttachResult => {
    // Read-then-register is synchronous: no update produced by a concurrently
    // streaming turn can slip between the replay snapshot and going live. The
    // burst this can send in one macrotask is bounded by the journal byte cap.
    const cursor = resolveCursor(mode)
    if (cursor !== null) {
      const firstSeq = journal[0]?.seq
      // Seqs are contiguous (append-only, evicted from the head), so the
      // replay start is an index computation, not a scan. A cursor older than
      // retention simply replays the retained suffix — the client's own
      // transcript covers everything older.
      const start = firstSeq === undefined ? journal.length : Math.max(0, cursor + 1 - firstSeq)
      for (let i = start; i < journal.length; i++) {
        sink(journal[i].update)
      }
    }
    observers.add(sink)
    touch()
    return {
      turnActive: activeTurn !== null,
      turn: activeTurn?.record ?? lastTurn,
    }
  }

  const detach = (sink: UpdateSink): void => {
    if (observers.delete(sink)) {
      touch()
    }
  }

  const runPrompt = async (text: string): Promise<{ stopReason: StopReason }> => {
    if (activeTurn) {
      throw RequestError.invalidParams(undefined, 'a prompt turn is already running for this session')
    }
    const record: RunnerTurnRecord = { startSeq: nextSeq, endSeq: null, stopReason: null, errorMessage: null }
    let settleDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      settleDone = resolve
    })
    activeTurn = { record, bearer: currentBearer, done }
    lastTurn = record
    touch()
    try {
      const result = await bundle.harness.prompt(text)
      await bundle.harness.waitForIdle()
      if (result.stopReason === 'error') {
        record.errorMessage = result.errorMessage ?? 'the model request failed'
        throw new Error(record.errorMessage)
      }
      const stopReason = toAcpStopReason(result.stopReason)
      record.stopReason = stopReason
      return { stopReason }
    } catch (error) {
      if (!record.errorMessage) {
        record.errorMessage = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally {
      record.endSeq = latestSeq()
      activeTurn = null
      touch()
      settleDone()
    }
  }

  const prompt = (text: string): Promise<{ stopReason: StopReason }> => {
    const turn = runPrompt(text)
    // The awaiting connection may vanish mid-turn; the outcome is recorded on
    // the turn record either way, so a detached rejection must not surface as
    // an unhandled rejection.
    turn.catch(() => {})
    return turn
  }

  const awaitTurnEnd = async (): Promise<RunnerTurnRecord | null> => {
    if (activeTurn) {
      await activeTurn.done
    }
    return lastTurn
  }

  return {
    sessionId,
    userId,
    runSpec: () => currentRunSpec,
    reopen,
    attach,
    detach,
    setBearer: (bearer) => {
      currentBearer = bearer
    },
    modelBearer,
    prompt,
    cancel: async () => {
      await bundle.harness.abort()
    },
    awaitTurnEnd,
    turnActive: () => activeTurn !== null,
    isIdleSince: (cutoffMs) => observers.size === 0 && activeTurn === null && lastActivityAt < cutoffMs,
    dispose: async () => {
      unsubscribe()
      observers.clear()
      await bundle.dispose()
    },
  }
}

/** What a connection brings to every session operation: who it acts as, the
 *  bearer its model requests will use, the skills it advertised, and the model
 *  and reasoning depth it wants executed. */
export type SessionRequest = {
  readonly userId: string
  readonly bearer: string
  readonly skills: readonly SkillDefinition[]
  readonly runSpec: RunSpec
}

/** Process-global registry of live session runtimes, keyed by ACP sessionId. */
export type SessionRegistry = {
  /** Mint a new session and build its runtime. Rejects past the per-user cap. */
  create: (request: SessionRequest) => Promise<SessionRuntime>
  /** Return the live runtime for `sessionId`, or rehydrate it from the disk
   *  session log, executing under `request.runSpec` unless a turn is already
   *  running. Rejects when the session does not exist for this user. */
  resume: (request: SessionRequest & { readonly sessionId: string }) => Promise<SessionRuntime>
  /** Live runtime lookup with ownership enforcement. Throws the same error for
   *  "missing" and "not yours" so existence never leaks across users. */
  require: (userId: string, sessionId: string) => SessionRuntime
  /** Like {@link require}, but first makes the session execute under
   *  `request.runSpec` — rebuilding the harness when the client switched model
   *  while idle, rejecting when it switched during a running turn. */
  requireForTurn: (request: SessionRequest & { readonly sessionId: string }) => Promise<SessionRuntime>
  /** Reject a new turn when `userId` already runs the maximum concurrently. */
  requireTurnSlot: (userId: string) => void
  /** Dispose the live runtime (if any) and hard-delete the session's disk
   *  state. Unknown or foreign sessions raise the usual invalid-params error. */
  delete: (userId: string, sessionId: string) => Promise<void>
  /** Erase everything the runner holds for `userId` (account deletion). */
  purgeUser: (userId: string) => Promise<void>
  /** Dispose runtimes idle past `ttlMs`. Returns how many were swept. */
  sweep: (ttlMs: number) => Promise<number>
  /** Hard-delete disk state for sessions untouched within the retention
   *  window. Returns how many sessions were removed. */
  purgeExpired: (retentionMs: number) => Promise<number>
  /** Tear everything down (shutdown). */
  disposeAll: () => Promise<void>
}

export const createSessionRegistry = (
  config: RunnerConfig,
  openHarness: OpenHarnessFor = openHarnessFor,
  storage: SessionStorage = createSessionStorage(config.dataDir),
): SessionRegistry => {
  const store = createSessionStore(join(config.dataDir, 'sessions'))
  const live = new Map<string, SessionRuntime>()
  // Per-session build/resume gate: two connections resuming the same session
  // concurrently must converge on one runtime, not race two harnesses onto one
  // disk log.
  const pending = new Map<string, Promise<SessionRuntime>>()

  const register = (sessionId: string, buildOne: () => Promise<SessionRuntime>): Promise<SessionRuntime> => {
    const inFlight = pending.get(sessionId)
    if (inFlight) return inFlight
    const task = buildOne()
      .then((runtime) => {
        live.set(sessionId, runtime)
        return runtime
      })
      .finally(() => {
        pending.delete(sessionId)
      })
    pending.set(sessionId, task)
    return task
  }

  const ownedBy = (userId: string): SessionRuntime[] => [...live.values()].filter((one) => one.userId === userId)

  const buildFor = (request: SessionRequest, sessionId: string, existing: boolean): Promise<SessionRuntime> =>
    register(sessionId, () =>
      createSessionRuntime({
        sessionId,
        userId: request.userId,
        bearer: request.bearer,
        runSpec: request.runSpec,
        openHarness: openHarness({
          config,
          store,
          sessionId,
          userId: request.userId,
          workspaceDir: storage.workspaceDir(request.userId, sessionId),
          skills: request.skills,
          existing,
        }),
      }),
    )

  const requireOwned = (userId: string, sessionId: string): SessionRuntime => {
    const runtime = live.get(sessionId)
    if (!runtime || runtime.userId !== userId) {
      throw unknownSession(sessionId)
    }
    return runtime
  }

  const evict = (runtime: SessionRuntime): SessionRuntime => {
    live.delete(runtime.sessionId)
    return runtime
  }

  return {
    create: async (request) => {
      assertSafeSegment(request.userId, 'user id')
      if (ownedBy(request.userId).length >= config.maxSessionsPerUser) {
        throw RequestError.invalidParams(
          undefined,
          `session limit reached: at most ${config.maxSessionsPerUser} live sessions per user`,
        )
      }
      return buildFor(request, crypto.randomUUID(), false)
    },
    resume: async (request) => {
      assertSafeSegment(request.userId, 'user id')
      if (!sessionIdPattern.test(request.sessionId)) {
        throw RequestError.invalidParams(undefined, `invalid session id '${request.sessionId}'`)
      }
      const runtime = live.get(request.sessionId)
      if (runtime) {
        if (runtime.userId !== request.userId) {
          throw unknownSession(request.sessionId)
        }
        // Reattaching mid-turn must not fail because the client's model choice
        // moved on while it was away: the running turn keeps the spec it started
        // with, and the next prompt carries (and applies) its own.
        if (!runtime.turnActive()) {
          await runtime.reopen(request.runSpec)
        }
        return runtime
      }
      // The disk log lives under this user's workspace-derived cwd, so a
      // sessionId belonging to another user simply fails to open.
      return buildFor(request, request.sessionId, true)
    },
    require: requireOwned,
    requireForTurn: async (request) => {
      const runtime = requireOwned(request.userId, request.sessionId)
      await runtime.reopen(request.runSpec)
      return runtime
    },
    requireTurnSlot: (userId) => {
      const running = ownedBy(userId).filter((runtime) => runtime.turnActive()).length
      if (running >= config.maxConcurrentTurnsPerUser) {
        throw RequestError.invalidParams(
          undefined,
          `turn limit reached: at most ${config.maxConcurrentTurnsPerUser} concurrent turns per user`,
        )
      }
    },
    delete: async (userId, sessionId) => {
      assertSafeSegment(userId, 'user id')
      if (!sessionIdPattern.test(sessionId)) {
        throw RequestError.invalidParams(undefined, `invalid session id '${sessionId}'`)
      }
      const runtime = live.get(sessionId)
      if (runtime && runtime.userId !== userId) {
        throw unknownSession(sessionId)
      }
      if (runtime) {
        await evict(runtime).dispose()
      }
      if (!(await storage.deleteSession(userId, sessionId))) {
        throw unknownSession(sessionId)
      }
    },
    purgeUser: async (userId) => {
      assertSafeSegment(userId, 'user id')
      // Erasure must complete even if a harness teardown fails.
      await Promise.allSettled(ownedBy(userId).map((runtime) => evict(runtime).dispose()))
      await storage.deleteUser(userId)
    },
    sweep: async (ttlMs) => {
      const cutoff = Date.now() - ttlMs
      const idle = [...live.values()].filter((runtime) => runtime.isIdleSince(cutoff))
      const outcomes = await Promise.allSettled(idle.map((runtime) => evict(runtime).dispose()))
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          process.stderr.write(`cloud-runner: session dispose failed: ${String(outcome.reason)}\n`)
        }
      }
      return idle.length
    },
    purgeExpired: (retentionMs) => storage.purgeExpired(Date.now() - retentionMs, (sessionId) => live.has(sessionId)),
    disposeAll: async () => {
      const all = [...live.values()]
      live.clear()
      await Promise.allSettled(all.map((runtime) => runtime.dispose()))
    },
  }
}
