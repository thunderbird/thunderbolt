/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Ask the coding-agent broker to provision a fresh `GH_TOKEN` for a developer.
 *
 * The broker holds the GitHub App credentials and each user's refresh token; it
 * mints a short-lived user-to-server access token and writes it into that user's
 * workspace Secret, so Cline acts *as the developer* on GitHub. We authenticate
 * to the broker with a shared service token and identify the developer with the
 * Better-Auth `user.id` — the broker never sees the end-user's Better-Auth token.
 *
 * The call is bounded by a timeout and retried on transient (network / 5xx)
 * failures; terminal outcomes (409 not-connected, 501 disabled, other 4xx) are
 * never retried.
 */

export type ProvisionResult =
  | { status: 'ok' }
  /** The developer has not connected GitHub yet (broker 409) — prompt them to. */
  | { status: 'not_connected' }
  /** The broker is reachable but provisioning is disabled (broker 501) — proceed read-only. */
  | { status: 'disabled' }
  /** The broker could not provision (timeout / network / 5xx / misconfig) — not the dev's fault. */
  | { status: 'failed'; reason: string }

export type ProvisionOptions = {
  /** Broker base URL, e.g. https://coding-agent-broker.thunderbird.net */
  brokerUrl: string
  /** Shared service token authenticating Thunderbolt → broker. */
  serviceToken: string
  fetchFn: typeof fetch
  /** Per-attempt timeout (ms). Default 8000. */
  timeoutMs?: number
  /** Total attempts including the first. Default 2. */
  maxAttempts?: number
}

const isRetryableStatus = (status: number): boolean => status >= 500

/**
 * POST /github/provision on the broker for `userId`. Maps the broker's response
 * to a {@link ProvisionResult}; the access token itself never transits here — it
 * lands directly in the workspace Secret. The reason string is kept body-free
 * (only the numeric status) so a broker error body can never reach logs.
 */
export const provisionWorkspaceToken = async (opts: ProvisionOptions, userId: string): Promise<ProvisionResult> => {
  const url = `${opts.brokerUrl.trim().replace(/\/+$/, '')}/github/provision`
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxAttempts = opts.maxAttempts ?? 2
  let lastReason = 'broker unreachable'

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await opts.fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.serviceToken}`,
          'x-tb-user-id': userId,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Network error / timeout — transient, retry until attempts exhausted.
      lastReason = err instanceof Error && err.name === 'TimeoutError' ? 'broker timeout' : 'broker unreachable'
      continue
    }

    if (res.ok) {
      return { status: 'ok' }
    }
    if (res.status === 409) {
      return { status: 'not_connected' }
    }
    if (res.status === 501) {
      return { status: 'disabled' }
    }
    lastReason = `broker ${res.status}`
    if (!isRetryableStatus(res.status)) {
      return { status: 'failed', reason: lastReason }
    }
    // retryable 5xx — fall through to the next attempt
  }

  return { status: 'failed', reason: lastReason }
}
