/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where a built-in thread's turns execute: on this device, or on the cloud
 * runner.
 *
 * This is NOT an agent choice — there is one Thunderbolt agent and the user never
 * picks a location. Placement is a property of the THREAD, decided on its first
 * send and pinned from then on by a non-null `chatThreads.acpSessionId` (a local
 * built-in thread never writes one). A conversation therefore never migrates:
 * everything that made the first turn eligible is either durable for the thread's
 * life or, if it changes later, becomes a loud failure rather than a silent move.
 *
 * The decision is a pure function of {@link BuiltInPlacementInputs} so the whole
 * truth table is testable; {@link decideBuiltInPlacement} is the impure half that
 * reads the settings and integration status behind a DI seam.
 */

import { getIntegrationStatus as defaultGetIntegrationStatus, getSettings as defaultGetSettings } from '@/dal'
import { getDb as defaultGetDb } from '@/db/database'
import { isBuiltInAgent } from '@/defaults/agents'
import { getCachedSession as defaultGetCachedSession, isCachedSessionValid } from '@/lib/session-cache'
import { getAuthToken as defaultGetAuthToken } from '@/lib/auth-token'
import { isStandaloneMode as defaultIsStandaloneMode } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import type { Agent } from '@/types/acp'

/**
 * Placement outcome for one send.
 *
 * `refuse` is not a fallback: it means the thread is pinned to the runner but
 * this send cannot honor that, so the send must fail loudly. Silently running it
 * on the device would fork the conversation — the runner already holds session
 * state and may have executed side effects.
 */
export type BuiltInPlacement = 'local' | 'runner' | 'refuse'

/** Why {@link resolveBuiltInPlacement} decided what it did. Diagnostic only —
 *  behavior branches on `placement` — except that a `refuse` reason picks the
 *  user-facing message via {@link builtInPlacementRefusalMessage}. */
export type BuiltInPlacementReason =
  | 'not-built-in-agent'
  | 'runner-owned'
  | 'runner-owned-encrypted'
  | 'runner-owned-unreachable'
  | 'runner-owned-needs-device-tools'
  | 'runner-owned-needs-attachments'
  | 'thread-already-local'
  | 'no-runner-configured'
  | 'not-authenticated'
  | 'standalone'
  | 'encrypted-thread'
  | 'confidential-model'
  | 'model-not-on-gateway'
  | 'model-without-tool-use'
  | 'mcp-clients-enabled'
  | 'device-only-tools-enabled'
  | 'attachments'
  | 'eligible'

export type BuiltInPlacementDecision = {
  readonly placement: BuiltInPlacement
  readonly reason: BuiltInPlacementReason
}

export type BuiltInPlacementInputs = {
  /** The thread's selected agent. Anything but the built-in agent is left alone. */
  readonly agent: Agent
  /** Whether this thread is already pinned to the runner. Derived from the
   *  persisted marker — a built-in thread with a non-null `acpSessionId` — or
   *  from a runner turn this chat instance already placed, since the marker's
   *  write has to round-trip through sync before it is readable. */
  readonly isRunnerOwned: boolean
  /** Whether the thread is an encrypted (confidential-model) conversation. */
  readonly isEncryptedThread: boolean
  /** The model this send would run. */
  readonly model: Model
  /** The runner's endpoint from app config, or null when the deployment has none. */
  readonly runnerWsUrl: string | null
  /** Whether the thread already has turns before this send. An existing local
   *  conversation stays local: its transcript is the only context the runner
   *  would get, and its harness state (files, tool history) is on this device. */
  readonly hasPriorTurns: boolean
  /** A real, non-anonymous account with a bearer token. The runner is
   *  owner-scoped, so an anonymous session has nothing to own a session with. */
  readonly isAuthenticated: boolean
  /** Desktop app with no backend reachable. */
  readonly isStandalone: boolean
  /** Any enabled MCP client on this send. Their transports terminate on this
   *  device, so the runner could not call them. */
  readonly hasMcpClients: boolean
  /** Any enabled tool that only works on this device — tasks, Google,
   *  Microsoft. `render_html` and the Pro web tools are excluded: the runner
   *  serves both itself (static validation for artifacts, backend HTTP under
   *  the user's bearer for search/fetch). */
  readonly hasDeviceOnlyTools: boolean
  /** Any attachment on the outgoing message. Their bytes live in this device's
   *  IndexedDB. */
  readonly hasAttachments: boolean
}

/** The one thing a runner-owned thread cannot supply, when a send must be refused. */
const refusalMessages: Partial<Record<BuiltInPlacementReason, string>> = {
  'runner-owned-encrypted': 'Encrypted conversations cannot run on Thunderbolt servers.',
  'runner-owned-unreachable': 'This conversation runs on Thunderbolt servers, which are currently unavailable.',
  'runner-owned-needs-device-tools':
    'This conversation runs on Thunderbolt servers, which cannot use tools that need this device. Start a new chat to use them.',
  'runner-owned-needs-attachments':
    'This conversation runs on Thunderbolt servers, which cannot read files from this device. Start a new chat to attach files.',
}

/**
 * The message to fail a refused send with.
 *
 * @param reason - reason from a `refuse` decision
 */
export const builtInPlacementRefusalMessage = (reason: BuiltInPlacementReason): string =>
  refusalMessages[reason] ?? 'This conversation cannot continue on Thunderbolt servers.'

/** Sticky path for a thread the runner already owns. It can only continue there
 *  or fail — see {@link BuiltInPlacement}. */
const resolveRunnerOwned = (inputs: BuiltInPlacementInputs): BuiltInPlacementDecision => {
  if (inputs.isEncryptedThread) {
    return { placement: 'refuse', reason: 'runner-owned-encrypted' }
  }
  if (!inputs.runnerWsUrl) {
    return { placement: 'refuse', reason: 'runner-owned-unreachable' }
  }
  if (inputs.hasAttachments) {
    return { placement: 'refuse', reason: 'runner-owned-needs-attachments' }
  }
  if (inputs.hasMcpClients || inputs.hasDeviceOnlyTools) {
    return { placement: 'refuse', reason: 'runner-owned-needs-device-tools' }
  }
  return { placement: 'runner', reason: 'runner-owned' }
}

/** First-turn eligibility. Every disqualifier keeps the thread on this device,
 *  which is always a correct place to run. */
const resolveFirstTurn = (inputs: BuiltInPlacementInputs): BuiltInPlacementDecision => {
  const local = (reason: BuiltInPlacementReason): BuiltInPlacementDecision => ({ placement: 'local', reason })
  if (inputs.hasPriorTurns) {
    return local('thread-already-local')
  }
  if (!inputs.runnerWsUrl) {
    return local('no-runner-configured')
  }
  if (!inputs.isAuthenticated) {
    return local('not-authenticated')
  }
  if (inputs.isStandalone) {
    return local('standalone')
  }
  if (inputs.isEncryptedThread) {
    return local('encrypted-thread')
  }
  if (inputs.model.isConfidential === 1) {
    return local('confidential-model')
  }
  // The runner runs models through the backend inference gateway, so only models
  // the gateway serves can run there. Matching on the provider (never on model
  // ids) keeps catalog changes out of this decision.
  if (inputs.model.provider !== 'thunderbolt') {
    return local('model-not-on-gateway')
  }
  if (inputs.model.toolUsage === 0) {
    return local('model-without-tool-use')
  }
  if (inputs.hasMcpClients) {
    return local('mcp-clients-enabled')
  }
  if (inputs.hasDeviceOnlyTools) {
    return local('device-only-tools-enabled')
  }
  if (inputs.hasAttachments) {
    return local('attachments')
  }
  return { placement: 'runner', reason: 'eligible' }
}

/**
 * Decide where this send executes.
 *
 * @param inputs - everything the decision depends on, gathered by
 *   {@link decideBuiltInPlacement}
 */
export const resolveBuiltInPlacement = (inputs: BuiltInPlacementInputs): BuiltInPlacementDecision => {
  if (!isBuiltInAgent(inputs.agent)) {
    return { placement: 'local', reason: 'not-built-in-agent' }
  }
  return inputs.isRunnerOwned ? resolveRunnerOwned(inputs) : resolveFirstTurn(inputs)
}

/** DI seam for {@link decideBuiltInPlacement} — every impure read the
 *  decision needs, so tests drive placement without a DB or localStorage. */
export type BuiltInPlacementDeps = {
  getDb?: typeof defaultGetDb
  getSettings?: typeof defaultGetSettings
  getIntegrationStatus?: typeof defaultGetIntegrationStatus
  getCachedSession?: typeof defaultGetCachedSession
  getAuthToken?: typeof defaultGetAuthToken
  isStandaloneMode?: typeof defaultIsStandaloneMode
}

/** What the caller knows and the collector cannot read for itself. */
export type BuiltInPlacementRequest = Pick<
  BuiltInPlacementInputs,
  | 'agent'
  | 'isRunnerOwned'
  | 'isEncryptedThread'
  | 'model'
  | 'runnerWsUrl'
  | 'hasPriorTurns'
  | 'hasMcpClients'
  | 'hasAttachments'
>

/**
 * Whether this device holds a usable, non-anonymous identity.
 *
 * Read from the cached session rather than the network: placement happens on the
 * send path, and an offline device with a valid cached session is still the same
 * account. An anonymous session is excluded — the runner scopes every session to
 * an owner, and an anonymous identity is per-device by construction.
 */
const isAuthenticatedAccount = (deps: BuiltInPlacementDeps): boolean => {
  const getAuthToken = deps.getAuthToken ?? defaultGetAuthToken
  if (!getAuthToken()) {
    return false
  }
  const cached = (deps.getCachedSession ?? defaultGetCachedSession)()
  return cached !== null && isCachedSessionValid(cached) && cached.user?.isAnonymous !== true
}

/**
 * Whether any enabled tool needs this device.
 *
 * Mirrors the availability gates in `getAvailableTools`: the tasks extension
 * and the Google/Microsoft integrations. Everything on that list authenticates
 * or executes locally, so a runner-placed turn would silently lose it — which
 * is why an enabled one keeps the thread on this device instead.
 *
 * The Pro toolset (`search`, `fetch_content`) is deliberately NOT on this
 * list: those tools are backend HTTP calls under the user's bearer, and the
 * runner serves them itself (`cloud-runner/src/pro-tools.ts`), so Pro being
 * enabled costs a runner-placed turn nothing.
 */
const hasDeviceOnlyToolsEnabled = async (deps: BuiltInPlacementDeps): Promise<boolean> => {
  const db = (deps.getDb ?? defaultGetDb)()
  const settings = await (deps.getSettings ?? defaultGetSettings)(db, {
    experimental_feature_tasks: false,
  })
  if (settings.experimentalFeatureTasks) {
    return true
  }
  const integrationStatus = await (deps.getIntegrationStatus ?? defaultGetIntegrationStatus)(db)
  return integrationStatus.googleEnabled || integrationStatus.microsoftEnabled
}

/**
 * Decide where this send executes, reading the inputs the caller cannot supply.
 *
 * Tool availability costs two DB round-trips, so it is read only once everything
 * else points at the runner. Every other input can rule the runner out on its
 * own, and a send that stays on this device would pay for an answer that cannot
 * change the outcome (`local` either way, only the diagnostic reason differs).
 *
 * @param request - what the caller knows about this send
 * @param deps - impure-read overrides for tests
 */
export const decideBuiltInPlacement = async (
  request: BuiltInPlacementRequest,
  deps: BuiltInPlacementDeps = {},
): Promise<BuiltInPlacementDecision> => {
  const inputs: BuiltInPlacementInputs = {
    ...request,
    isAuthenticated: isAuthenticatedAccount(deps),
    isStandalone: (deps.isStandaloneMode ?? defaultIsStandaloneMode)(),
    hasDeviceOnlyTools: false,
  }
  const optimistic = resolveBuiltInPlacement(inputs)
  if (optimistic.placement !== 'runner') {
    return optimistic
  }
  return resolveBuiltInPlacement({ ...inputs, hasDeviceOnlyTools: await hasDeviceOnlyToolsEnabled(deps) })
}
