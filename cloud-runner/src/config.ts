/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Environment configuration for the runner.
 *
 * The runner is a standalone service (deployed on AWS, but host-agnostic): it
 * has no database, no shared secrets, and — deliberately — no model provider
 * credentials of its own. `BACKEND_URL` is its only backend coupling, and it
 * carries two roles: introspecting the app bearer tokens that arrive on the
 * WebSocket subprotocol (see `auth.ts`), and hosting the inference gateway
 * (`POST /v1/chat/completions`) that every model request is routed through,
 * authenticated with the session owner's own bearer. A user therefore gets
 * exactly the model access their account already has, and a compromised runner
 * leaks no provider keys because it holds none.
 *
 * There is deliberately no model or reasoning-depth setting here: the client
 * sends both per session and per turn in the ACP run spec (`shared/acp-types.ts`),
 * so the runner never has a model opinion to drift from the app's.
 */

export type RunnerConfig = {
  /** TCP port the WebSocket/health server listens on. */
  readonly port: number
  /** Thunderbolt backend origin — bearer introspection and inference gateway,
   *  e.g. `https://api.thunderbolt.example`. */
  readonly backendUrl: string
  /** Root directory for persisted state: session logs and per-session
   *  workspaces. Mount durable storage (EFS) here in production. */
  readonly dataDir: string
  /** Dispose in-memory session runtimes idle (no observer, no running turn)
   *  for longer than this. Disk session logs survive for `session/resume`. */
  readonly idleSessionTtlMs: number
  /** How often a live connection's bearer is re-introspected, so a revoked or
   *  expired session is evicted instead of living until the socket closes. */
  readonly revalidateIntervalMs: number
  /** Cap on live session runtimes one user may hold. */
  readonly maxSessionsPerUser: number
  /** Cap on prompt turns one user may have in flight at once. */
  readonly maxConcurrentTurnsPerUser: number
  /** Hard-delete session logs and workspaces untouched for longer than this. */
  readonly retentionMs: number
}

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`missing required env var ${name}`)
  }
  return value
}

/**
 * Read a positive numeric env var, falling back when it is unset or blank.
 *
 * @param name - environment variable name
 * @param fallback - value used when the variable is absent
 */
const positiveNumber = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number; got '${raw}'`)
  }
  return value
}

/** Read and validate the runner configuration from the environment. */
export const loadConfig = (): RunnerConfig => ({
  port: positiveNumber('PORT', 8080),
  backendUrl: required('BACKEND_URL').replace(/\/$/, ''),
  dataDir: process.env.CLOUD_RUNNER_DATA_DIR?.trim() || '/data',
  idleSessionTtlMs: positiveNumber('CLOUD_RUNNER_IDLE_SESSION_TTL_MS', 30 * 60 * 1000),
  revalidateIntervalMs: positiveNumber('CLOUD_RUNNER_REVALIDATE_INTERVAL_MS', 5 * 60 * 1000),
  maxSessionsPerUser: positiveNumber('CLOUD_RUNNER_MAX_SESSIONS_PER_USER', 20),
  maxConcurrentTurnsPerUser: positiveNumber('CLOUD_RUNNER_MAX_CONCURRENT_TURNS_PER_USER', 3),
  retentionMs: positiveNumber('CLOUD_RUNNER_RETENTION_DAYS', 30) * 24 * 60 * 60 * 1000,
})

/** OpenAI-compatible base URL of the backend's inference gateway. Pi appends
 *  `/chat/completions` to it. */
export const gatewayBaseUrl = (config: RunnerConfig): string => `${config.backendUrl}/v1`
