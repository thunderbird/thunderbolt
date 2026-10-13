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
    const error = await solveAltchaChallenge(httpClient, createWorker).catch((err: Error) => err)
    expect(error).toEqual(new Error('ALTCHA worker failed'))
    expect(terminate).toHaveBeenCalledTimes(navigator.hardwareConcurrency || 1)
  })

  it('rejects and terminates the workers when no worker answers within 60 seconds', async () => {
    const { createWorker, terminate, created } = createStuckWorkers(false)
    const solving = solveAltchaChallenge(httpClient, createWorker)
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
})
