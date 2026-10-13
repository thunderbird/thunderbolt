/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { solveChallengeWorkers } from 'altcha-lib/v1'
import type { Challenge } from 'altcha-lib/v1/types'

const createAltchaWorker = () => new Worker(new URL('./altcha.worker.ts', import.meta.url), { type: 'module' })

/** Upper bound on one solve, so a worker that never answers still reaches the gate's retry state. */
const altchaSolveTimeoutMs = 60_000

/**
 * Fetch an ALTCHA challenge from the API and solve it in web workers, off the main thread.
 * Resolves the base64 payload the anonymous sign-in sends as `x-captcha-token`; rejects when
 * the fetch fails, a worker errors (chunk fails to load, no `crypto.subtle` on an insecure
 * origin), the solve outlasts `altchaSolveTimeoutMs`, or the search ends without a solution.
 * altcha-lib listens only for worker messages, so the error and timeout races live here.
 * Each challenge redeems once, so the auth gate calls this again for every sign-in attempt;
 * `createWorker` is replaced only by tests.
 */
export const solveAltchaChallenge = async (
  httpClient: HttpClient,
  createWorker: () => Worker = createAltchaWorker,
): Promise<string> => {
  const { algorithm, challenge, maxnumber, salt, signature } = await httpClient
    .get('captcha/challenge')
    .json<Challenge>()
  const workers: Worker[] = []
  const failure = Promise.withResolvers<never>()
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
    // altcha-lib terminates its workers only after every one has answered.
    for (const worker of workers) {
      worker.terminate()
    }
  }
}
