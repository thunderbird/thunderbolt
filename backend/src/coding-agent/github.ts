/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read-only GitHub-connection queries against the coding-agent broker, used by
 * the user-facing `github_connect` / `github_status` assistant tools.
 *
 * As with {@link ./provision}, we authenticate to the broker with the shared
 * service token and identify the developer with the Better-Auth `user.id` — the
 * broker never sees the end-user's Better-Auth token. The `user.id` is resolved
 * server-side from the authenticated session (see `./github-routes`), so the
 * model that invokes these tools cannot spoof which user it acts as.
 *
 * Calls are bounded by a timeout and retried on transient (network / 5xx)
 * failures; a terminal 4xx is never retried.
 */

export type AuthorizeUrlResult =
  | { status: 'ok'; url: string }
  /** The broker is reachable but GitHub connect is disabled (501). */
  | { status: 'disabled' }
  /** The broker could not produce a URL (timeout / network / 5xx / bad body). */
  | { status: 'failed'; reason: string }

export type GithubStatusResult =
  | { status: 'ok'; connected: boolean }
  | { status: 'disabled' }
  | { status: 'failed'; reason: string }

export type BrokerGithubOptions = {
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

const normalizeBase = (brokerUrl: string): string => brokerUrl.trim().replace(/\/+$/, '')

type RawResult = { kind: 'ok'; res: Response } | { kind: 'disabled' } | { kind: 'failed'; reason: string }

/**
 * GET `path` on the broker with the service token + `x-tb-user-id` header.
 * Handles retry/timeout uniformly; the caller parses the body for the OK case.
 * The reason string stays body-free (numeric status only) so a broker error body
 * can never reach logs.
 */
const brokerGet = async (opts: BrokerGithubOptions, path: string, userId: string): Promise<RawResult> => {
  const url = `${normalizeBase(opts.brokerUrl)}${path}`
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxAttempts = opts.maxAttempts ?? 2
  let lastReason = 'broker unreachable'

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      res = await opts.fetchFn(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${opts.serviceToken}`,
          'x-tb-user-id': userId,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      lastReason = err instanceof Error && err.name === 'TimeoutError' ? 'broker timeout' : 'broker unreachable'
      continue
    }

    if (res.ok) {
      return { kind: 'ok', res }
    }
    if (res.status === 501) {
      return { kind: 'disabled' }
    }
    lastReason = `broker ${res.status}`
    if (!isRetryableStatus(res.status)) {
      return { kind: 'failed', reason: lastReason }
    }
    // retryable 5xx — fall through to the next attempt
  }

  return { kind: 'failed', reason: lastReason }
}

/** GET /github/authorize-url → the per-user GitHub OAuth authorize URL to click. */
export const fetchAuthorizeUrl = async (opts: BrokerGithubOptions, userId: string): Promise<AuthorizeUrlResult> => {
  const raw = await brokerGet(opts, '/github/authorize-url', userId)
  if (raw.kind === 'disabled') {
    return { status: 'disabled' }
  }
  if (raw.kind === 'failed') {
    return { status: 'failed', reason: raw.reason }
  }
  let body: unknown
  try {
    body = await raw.res.json()
  } catch {
    return { status: 'failed', reason: 'broker bad body' }
  }
  const url = (body as { url?: unknown }).url
  if (typeof url !== 'string' || url.length === 0) {
    return { status: 'failed', reason: 'broker bad body' }
  }
  return { status: 'ok', url }
}

/** GET /github/status → whether this developer has connected GitHub. */
export const fetchGithubStatus = async (opts: BrokerGithubOptions, userId: string): Promise<GithubStatusResult> => {
  const raw = await brokerGet(opts, '/github/status', userId)
  if (raw.kind === 'disabled') {
    return { status: 'disabled' }
  }
  if (raw.kind === 'failed') {
    return { status: 'failed', reason: raw.reason }
  }
  let body: unknown
  try {
    body = await raw.res.json()
  } catch {
    return { status: 'failed', reason: 'broker bad body' }
  }
  const connected = (body as { connected?: unknown }).connected
  if (typeof connected !== 'boolean') {
    return { status: 'failed', reason: 'broker bad body' }
  }
  return { status: 'ok', connected }
}
