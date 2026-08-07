/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract shared by backend (`backend/src/agents/routes.ts`) and frontend
 * (`src/dal/agents.ts`, `src/db/seeding/seed-agents.ts`) for the ACP feature.
 *
 * Both ends consume the same shape — drift here is silent breakage, so every
 * identifier the discovery response carries lives in one place.
 */

import { thunderboltAcpMetaKey } from './agent-core/skills.ts'

export type AgentType = 'built-in' | 'remote-acp' | 'managed-acp'

export type AgentTransport = 'in-process' | 'websocket'

/** Descriptor returned by `GET /agents` for remote (`remote-acp`) and
 *  server-managed (`managed-acp`) agents. The built-in agent is never on the
 *  wire — it is a hardcoded frontend constant in `src/defaults/agents.ts`. */
export type RemoteAgentDescriptor = {
  id: string
  name: string
  type: 'remote-acp' | 'managed-acp'
  transport: 'websocket'
  url: string
  description: string | null
  icon: string | null
  isSystem: 0 | 1
}

/** Envelope for `GET /agents`. `version` lets us evolve the shape later;
 *  `allowCustomAgents` mirrors backend `ALLOW_CUSTOM_AGENTS` env so the UI can
 *  hide the "+ Add Custom Agent" button per deployment. */
export type AgentDiscoveryResponse = {
  version: '1'
  agents: RemoteAgentDescriptor[]
  allowCustomAgents: boolean
}

/* ------------------------------------------------------------------------- *
 * Runner run contract (ACP extension)
 *
 * The runner (`cloud-runner/`) is an execution target for the built-in agent,
 * not an agent of its own: the client picks the model and reasoning depth, the
 * runner executes them. It keeps a session's turn running after the WebSocket
 * drops and journals every `session/update` with a monotonically increasing
 * per-session `seq`, so a reconnecting client resumes its session normally and
 * then catches up via the extension methods below.
 *
 * Both ends consume these shapes — drift is silent breakage, so they live here.
 * ------------------------------------------------------------------------- */

/** Prefix of the detached-turn extension methods. It predates the single
 *  `_meta` namespace below and stays as-is: renaming a JSON-RPC method is
 *  protocol drift with no behavioral gain. */
const runnerMethodPrefix = 'thunderbolt.io/cloud'

/** Extension method: re-deliver journaled `session/update`s through the
 *  calling connection, then keep it attached for live updates. The replayed
 *  notifications arrive BEFORE the method's response (the SDK serializes
 *  writes). Request: {@link RunnerReplayRequest}; response:
 *  {@link RunnerReplayResponse}. */
export const runnerReplayMethod = `${runnerMethodPrefix}/replay`

/** Extension method: resolve when the session's in-flight turn ends (or
 *  immediately when idle). Request: {@link RunnerAwaitTurnRequest}; response:
 *  {@link RunnerAwaitTurnResponse}. */
export const runnerAwaitTurnMethod = `${runnerMethodPrefix}/awaitTurn`

/** Extension method: permanently delete a session's server-side state (session
 *  log, journal, workspace). Owner-scoped like every session operation. Called
 *  by the client when its thread is deleted, so runner-side history does not
 *  outlive the conversation. Request: {@link RunnerDeleteSessionRequest};
 *  response: empty object. */
export const runnerDeleteSessionMethod = `${runnerMethodPrefix}/deleteSession`

/** Journal coordinates of one prompt turn on the runner. `endSeq`/`stopReason`
 *  are null while the turn is still running. `stopReason` is the ACP stop
 *  reason; a model failure carries `errorMessage` instead. */
export type RunnerTurnRecord = {
  startSeq: number
  endSeq: number | null
  stopReason: string | null
  errorMessage: string | null
}

/** Request params of {@link runnerReplayMethod}. The runner always replays the
 *  whole current/last turn — the client's durable transcript covers everything
 *  older, so no finer cursor is exposed on the wire. */
export type RunnerReplayRequest = { sessionId: string }

/** Response of {@link runnerReplayMethod}. `turn` is the current (running) or
 *  last finished turn, `null` when the session has none to replay (including
 *  after a runner restart, which empties the journal). */
export type RunnerReplayResponse = {
  turnActive: boolean
  turn: RunnerTurnRecord | null
}

/** Request params of {@link runnerAwaitTurnMethod}. */
export type RunnerAwaitTurnRequest = { sessionId: string }

/** Request params of {@link runnerDeleteSessionMethod}. */
export type RunnerDeleteSessionRequest = { sessionId: string }

/** Response of {@link runnerAwaitTurnMethod}: the finished (or last) turn. */
export type RunnerAwaitTurnResponse = { turn: RunnerTurnRecord | null }

/* ------------------------------------------------------------------------- *
 * Run spec: the model and reasoning depth a session/turn executes under.
 * ------------------------------------------------------------------------- */

/** Reasoning depths the run spec accepts. Deliberately spelled out rather than
 *  imported from the harness: this is a wire enum, and {@link readRunSpec}
 *  validates against it. A runner-side assignment to the harness's own level
 *  type fails to compile if the two ever drift. */
export const runnerThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

/** Reasoning depth carried by a {@link RunSpec}. */
export type RunnerThinkingLevel = (typeof runnerThinkingLevels)[number]

/**
 * What one runner session/turn executes under. The client owns this choice —
 * the runner never substitutes a model — and `modelId` is whatever id the
 * backend inference gateway accepts, which stays the single authority on which
 * models exist.
 */
export type RunSpec = {
  readonly modelId: string
  readonly thinkingLevel: RunnerThinkingLevel
}

/** Field the run spec occupies inside the Thunderbolt `_meta` namespace. */
const runSpecMetaField = 'run'

/** ACP agent-capability metadata advertising detached (background) turns. The
 *  runner merges it with the skills capability under the same namespace. */
export const detachedTurnsCapabilityMeta = {
  [thunderboltAcpMetaKey]: { detachedTurns: true },
} as const

type AcpMeta = Readonly<Record<string, unknown>> | null | undefined

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isThinkingLevel = (value: unknown): value is RunnerThinkingLevel =>
  typeof value === 'string' && (runnerThinkingLevels as readonly string[]).includes(value)

/**
 * Merge ACP `_meta` payloads that share a namespace key.
 *
 * Skills and the run spec both live under the Thunderbolt namespace, so a plain
 * spread would drop whichever came first. Top-level keys merge; two record
 * values under the same key merge one level deeper, which is exactly the depth
 * every namespaced payload here occupies.
 *
 * @param metas - payloads to combine, later entries winning per leaf key
 */
export const mergeAcpMeta = (...metas: readonly AcpMeta[]): Record<string, unknown> => {
  const merged: Record<string, unknown> = {}
  for (const meta of metas) {
    if (!meta) {
      continue
    }
    for (const [namespace, value] of Object.entries(meta)) {
      const existing = merged[namespace]
      merged[namespace] = isRecord(existing) && isRecord(value) ? { ...existing, ...value } : value
    }
  }
  return merged
}

/**
 * Build the ACP session/prompt metadata carrying a run spec.
 *
 * @param spec - model and reasoning depth the turn must execute under
 * @returns namespaced ACP metadata payload, mergeable via {@link mergeAcpMeta}
 */
export const buildRunSpecMeta = (spec: RunSpec): Record<string, unknown> => ({
  [thunderboltAcpMetaKey]: { [runSpecMetaField]: spec },
})

/**
 * Read a complete run spec from ACP metadata.
 *
 * @param meta - metadata received on session/new, session/resume, or session/prompt
 * @returns the run spec, or `null` when absent or malformed — the runner turns
 *   that into an invalid-params error rather than picking a model itself
 */
export const readRunSpec = (meta: AcpMeta): RunSpec | null => {
  const namespace = meta?.[thunderboltAcpMetaKey]
  if (!isRecord(namespace)) {
    return null
  }
  const run = namespace[runSpecMetaField]
  if (!isRecord(run)) {
    return null
  }
  const { modelId, thinkingLevel } = run
  if (typeof modelId !== 'string' || modelId.trim() === '' || !isThinkingLevel(thinkingLevel)) {
    return null
  }
  return { modelId, thinkingLevel }
}

/**
 * Whether two run specs describe the same execution. A change means the harness
 * must be rebuilt, so this is the trigger for that, not a cosmetic comparison.
 */
export const sameRunSpec = (a: RunSpec, b: RunSpec): boolean =>
  a.modelId === b.modelId && a.thinkingLevel === b.thinkingLevel

/**
 * Detect an agent that keeps turns running after the connection drops, so the
 * client can enable reconnect catch-up.
 *
 * @param meta - agent capability metadata from the initialize response
 */
export const supportsDetachedTurns = (meta: AcpMeta): boolean => {
  const namespace = meta?.[thunderboltAcpMetaKey]
  return isRecord(namespace) && namespace.detachedTurns === true
}
