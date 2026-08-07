/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'

/** Per-attempt budget. Two attempts add at most ~10s to an account deletion. */
const purgeTimeoutMs = 5_000

/**
 * Derive the cloud runner's HTTP origin from its public WebSocket URL:
 * `wss://runner.example/path` → `https://runner.example`, `ws://localhost:8787`
 * → `http://localhost:8787`. An already-HTTP URL yields its own origin.
 *
 * @param wsUrl - absolute URL, typically `settings.cloudRunnerWsUrl`
 * @throws {TypeError} when `wsUrl` is not a valid absolute URL
 */
export const cloudRunnerHttpOrigin = (wsUrl: string): string => {
  const url = new URL(wsUrl)
  return `${url.protocol.replace(/^ws/, 'http')}//${url.host}`
}

/** Purge once. Returns `null` on success, or a short reason for the caller to log. */
const attemptPurge = async (wsUrl: string, authorization: string, fetchFn: typeof fetch): Promise<string | null> => {
  try {
    const response = await fetchFn(`${cloudRunnerHttpOrigin(wsUrl)}/purge`, {
      method: 'POST',
      headers: { authorization },
      signal: AbortSignal.timeout(purgeTimeoutMs),
    })
    return response.ok ? null : `status ${response.status}`
  } catch (error) {
    // Expected: the runner is down, unreachable, slower than the timeout, or
    // CLOUD_RUNNER_WS_URL is malformed.
    return error instanceof Error ? error.name : 'unknown error'
  }
}

type PurgeOptions = {
  settings: Pick<Settings, 'cloudRunnerWsUrl'>
  /** The requester's own `Authorization` header, forwarded verbatim. */
  authorization: string | null
  fetchFn: typeof fetch
}

/**
 * Ask the cloud runner to hard-delete everything it holds for the requesting
 * user. The runner authorizes the purge by introspecting the forwarded bearer
 * back against this backend, so this must run *before* the user's sessions are
 * deleted — afterwards the bearer no longer resolves and the purge 401s.
 *
 * No runner configured means nothing to purge. Retries once on failure.
 *
 * @returns `null` when the runner purged (or there was nothing to purge),
 * otherwise a short failure reason.
 */
export const purgeCloudRunnerData = async ({
  settings,
  authorization,
  fetchFn,
}: PurgeOptions): Promise<string | null> => {
  const wsUrl = settings.cloudRunnerWsUrl.trim()
  if (!wsUrl) {
    return null
  }
  if (!authorization) {
    return 'missing authorization header'
  }
  const firstFailure = await attemptPurge(wsUrl, authorization, fetchFn)
  return firstFailure ? attemptPurge(wsUrl, authorization, fetchFn) : null
}
