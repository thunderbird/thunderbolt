/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient } from '@/lib/http'
import { getClock } from '@/testing-library'
import { createChallenge } from 'altcha-lib/v1'
import { describe, expect, it, mock } from 'bun:test'
import { solveAltchaChallenge } from './altcha'

const httpClient = createClient({
  fetch: async () => Response.json(await createChallenge({ hmacKey: 'test-key', maxnumber: 1000 })),
  prefixUrl: 'http://test-api.local',
})

/** An API that accepts the challenge request and never answers, until the request is aborted. */
const stalledHttpClient = createClient({
  fetch: (input) =>
    new Promise<Response>((_, reject) => {
      const { signal } = input as Request
      signal.addEventListener('abort', () => reject(signal.reason))
    }),
  prefixUrl: 'http://test-api.local',
})

/** Settle a solve into its outcome, so a test can await it after advancing the fake clock. */
const settle = (solving: Promise<string>) =>
  solving.then(
    () => 'solved',
    (err: Error) => err.name,
  )

/** A worker that never posts a solution: it errors on `work` when `fails`, otherwise stays silent. */
const createStuckWorkers = (fails: boolean) => {
  const terminate = mock(() => {})
  const created = Promise.withResolvers<void>()
  const createWorker = () => {
    created.resolve()
    const worker = new EventTarget()
    return Object.assign(worker, {
      postMessage: () => fails && queueMicrotask(() => worker.dispatchEvent(new Event('error'))),
      terminate,
    }) as unknown as Worker
  }
  return { createWorker, terminate, created: created.promise }
}

describe('solveAltchaChallenge', () => {
  it('rejects and terminates the workers when one errors', async () => {
    const { createWorker, terminate } = createStuckWorkers(true)

    // Not `.rejects`: Bun drains that synchronously, so a regression would hang instead of timing out.
    const error = await solveAltchaChallenge(httpClient, new AbortController().signal, createWorker).catch(
      (err: Error) => err,
    )
    expect(error).toEqual(new Error('ALTCHA worker failed'))
    expect(terminate).toHaveBeenCalledTimes(navigator.hardwareConcurrency || 1)
  })

  it('rejects and terminates the workers when no worker answers within 60 seconds', async () => {
    const { createWorker, terminate, created } = createStuckWorkers(false)
    const solving = solveAltchaChallenge(httpClient, new AbortController().signal, createWorker)
    const outcome = solving.then(
      () => 'solved',
      (err: Error) => err.message,
    )
    // The timer starts once the challenge has been fetched, just before the first worker spawns.
    await created

    await getClock().tickAsync(59_999)
    expect(terminate).not.toHaveBeenCalled()
    await getClock().tickAsync(1)
    expect(await outcome).toBe('ALTCHA solve timed out')
    expect(terminate).toHaveBeenCalled()
  })

  it('rejects when the challenge request stalls for 15 seconds, without starting a worker', async () => {
    const { createWorker, terminate } = createStuckWorkers(false)
    const progress = { settled: false }
    const outcome = settle(solveAltchaChallenge(stalledHttpClient, new AbortController().signal, createWorker))
    void outcome.then(() => (progress.settled = true))

    await getClock().tickAsync(14_999)
    expect(progress.settled).toBe(false)
    await getClock().tickAsync(1)
    expect(await outcome).toBe('TimeoutError')
    expect(terminate).not.toHaveBeenCalled()
  })

  it('rejects and terminates the workers when aborted mid-solve', async () => {
    const { createWorker, terminate, created } = createStuckWorkers(false)
    const controller = new AbortController()
    const outcome = settle(solveAltchaChallenge(httpClient, controller.signal, createWorker))
    await created

    controller.abort()
    expect(await outcome).toBe('AbortError')
    expect(terminate).toHaveBeenCalled()
  })

  it('starts no worker when the abort lands after the challenge response', async () => {
    const { createWorker, terminate } = createStuckWorkers(false)
    const controller = new AbortController()
    const fetched = Promise.withResolvers<void>()
    // A fetch that ignores the abort, as a response already on the wire does.
    const lateClient = createClient({
      fetch: async () => {
        controller.abort()
        fetched.resolve()
        return Response.json(await createChallenge({ hmacKey: 'test-key', maxnumber: 1000 }))
      },
      prefixUrl: 'http://test-api.local',
    })
    const outcome = settle(solveAltchaChallenge(lateClient, controller.signal, createWorker))
    await fetched.promise

    expect(await outcome).toBe('AbortError')
    expect(terminate).not.toHaveBeenCalled()
  })

  it('rejects without starting a worker when aborted while the challenge is in flight', async () => {
    const { createWorker, terminate } = createStuckWorkers(false)
    const controller = new AbortController()
    const outcome = settle(solveAltchaChallenge(stalledHttpClient, controller.signal, createWorker))

    controller.abort()
    expect(await outcome).toBe('AbortError')
    expect(terminate).not.toHaveBeenCalled()
  })
})
