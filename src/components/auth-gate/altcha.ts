/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpError, type HttpClient } from '@/lib/http'
import { solveChallengeWorkers } from 'altcha-lib/v1'
import type { Challenge } from 'altcha-lib/v1/types'

/** Create a module worker running `altcha.worker.ts`, which solves one slice of the challenge's search space. */
const createAltchaWorker = () => new Worker(new URL('./altcha.worker.ts', import.meta.url), { type: 'module' })

/**
 * Upper bound on the challenge fetch. The challenge is a few hundred bytes our own API mints
 * without I/O, so a healthy server answers in well under a second even on congested Wi-Fi;
 * 15 s leaves room for a slow mobile network while keeping a stalled server's spinner short.
 */
const challengeFetchTimeoutMs = 15_000

/** Upper bound on one solve, so a worker that never answers still reaches the gate's retry state. */
const altchaSolveTimeoutMs = 60_000

/**
 * A failure that a fresh attempt can fix, so the auth gate offers a retry instead of throwing:
 * the challenge fetch hit a network failure, its timeout or a 5xx, a worker failed, or the
 * solve timed out. A worker `error` event cannot say whether the worker chunk failed to load on
 * flaky Wi-Fi (a retry fixes it) or can never run (no `crypto.subtle` on an insecure origin),
 * so it counts as transient. Anything else `solveAltchaChallenge` rejects with, such as a 4xx
 * on the challenge or a challenge with no solution, is not transient.
 */
export class AltchaTransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AltchaTransientError'
  }
}

/**
 * fetch's network failure (a `TypeError`), the HttpClient timeout, or a 5xx. A 4xx (no ALTCHA
 * route, the challenge's own rate limit) is the API's considered answer, so a retry cannot help.
 * Known false positive: the browser reports a CORS rejection (the API missing the app's origin
 * in `CORS_ORIGINS`) as the same `TypeError`, so an endless browser check is worth a CORS look.
 */
const isTransientFetchFailure = (err: unknown) =>
  err instanceof TypeError ||
  (err instanceof DOMException && err.name === 'TimeoutError') ||
  (err instanceof HttpError && err.response.status >= 500)

/** GET the challenge, wrapping transient failures; checked here so a body that fails to parse is not one. */
const fetchChallenge = async (httpClient: HttpClient, signal: AbortSignal) => {
  try {
    return await httpClient.get('captcha/challenge', { timeout: challengeFetchTimeoutMs, signal }).json<Challenge>()
  } catch (err) {
    if (isTransientFetchFailure(err)) {
      throw new AltchaTransientError('ALTCHA challenge fetch failed', { cause: err })
    }
    throw err
  }
}

/**
 * Fetch an ALTCHA challenge from the API and solve it in web workers, off the main thread.
 * Resolves the base64 payload the anonymous sign-in sends as `x-captcha-token`. Rejects with
 * {@link AltchaTransientError} when the fetch fails on the network, outlasts
 * `challengeFetchTimeoutMs` or gets a 5xx, a worker errors, or the solve outlasts
 * `altchaSolveTimeoutMs`; with the original error for a 4xx or any other failure; and with
 * `signal`'s reason when it aborts (the auth gate unmounted). altcha-lib listens only for
 * worker messages, so the error, timeout and abort races live here.
 * Each challenge redeems once, so the auth gate calls this again for every sign-in attempt;
 * `createWorker` is replaced only by tests.
 */
export const solveAltchaChallenge = async (
  httpClient: HttpClient,
  signal: AbortSignal,
  createWorker: () => Worker = createAltchaWorker,
): Promise<string> => {
  const { algorithm, challenge, maxnumber, salt, signature } = await fetchChallenge(httpClient, signal)
  signal.throwIfAborted()
  const workers: Worker[] = []
  const failure = Promise.withResolvers<never>()
  const onAbort = () => failure.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const createWatchedWorker = () => {
    const worker = createWorker()
    worker.addEventListener('error', () => failure.reject(new AltchaTransientError('ALTCHA worker failed')))
    workers.push(worker)
    return worker
  }
  const timeout = setTimeout(
    () => failure.reject(new AltchaTransientError('ALTCHA solve timed out')),
    altchaSolveTimeoutMs,
  )
  try {
    const solution = await Promise.race([
      solveChallengeWorkers(
        createWatchedWorker,
        navigator.hardwareConcurrency || 1,
        challenge,
        salt,
        algorithm,
        maxnumber,
      ),
      failure.promise,
    ])
    if (!solution) {
      throw new Error('ALTCHA challenge has no solution')
    }
    return btoa(JSON.stringify({ algorithm, challenge, number: solution.number, salt, signature }))
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
    // altcha-lib terminates its workers only after every one has answered.
    for (const worker of workers) {
      worker.terminate()
    }
  }
}
