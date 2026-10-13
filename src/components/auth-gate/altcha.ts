/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { solveChallengeWorkers } from 'altcha-lib/v1'
import type { Challenge } from 'altcha-lib/v1/types'

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
 * Fetch an ALTCHA challenge from the API and solve it in web workers, off the main thread.
 * Resolves the base64 payload the anonymous sign-in sends as `x-captcha-token`; rejects when
 * the fetch fails or outlasts `challengeFetchTimeoutMs`, a worker errors (chunk fails to load,
 * no `crypto.subtle` on an insecure origin), the solve outlasts `altchaSolveTimeoutMs`, the
 * search ends without a solution, or `signal` aborts (the auth gate unmounted). altcha-lib
 * listens only for worker messages, so the error, timeout and abort races live here.
 * Each challenge redeems once, so the auth gate calls this again for every sign-in attempt;
 * `createWorker` is replaced only by tests.
 */
export const solveAltchaChallenge = async (
  httpClient: HttpClient,
  signal: AbortSignal,
  createWorker: () => Worker = createAltchaWorker,
): Promise<string> => {
  const { algorithm, challenge, maxnumber, salt, signature } = await httpClient
    .get('captcha/challenge', { timeout: challengeFetchTimeoutMs, signal })
    .json<Challenge>()
  signal.throwIfAborted()
  const workers: Worker[] = []
  const failure = Promise.withResolvers<never>()
  const onAbort = () => failure.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const createWatchedWorker = () => {
    const worker = createWorker()
    worker.addEventListener('error', () => failure.reject(new Error('ALTCHA worker failed')))
    workers.push(worker)
    return worker
  }
  const timeout = setTimeout(() => failure.reject(new Error('ALTCHA solve timed out')), altchaSolveTimeoutMs)
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
