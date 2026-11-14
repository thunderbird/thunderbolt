/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  concurrentWriteRetries,
  createKeyedLock,
  isConcurrentWriteConflict,
  sendRetryingConcurrentConflicts,
} from './concurrency'

const scimResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/scim+json' } })

const conflict = () =>
  scimResponse(409, { status: '409', detail: 'The SCIM identity changed concurrently; retry the request' })

const noWait = async () => {}

describe('createKeyedLock', () => {
  it('runs callbacks one at a time per key, in order, even after a failure', async () => {
    const lock = createKeyedLock()
    const events: string[] = []
    const step =
      (name: string, fail = false) =>
      async () => {
        events.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`${name}:end`)
        if (fail) {
          throw new Error(name)
        }
        return name
      }
    const results = await Promise.allSettled([
      lock('a', step('one', true)),
      lock('a', step('two')),
      lock('a', step('three')),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(events).toEqual(['one:start', 'one:end', 'two:start', 'two:end', 'three:start', 'three:end'])
  })

  it('runs different keys in parallel', async () => {
    const lock = createKeyedLock()
    const events: string[] = []
    const step = (name: string) => async () => {
      events.push(`${name}:start`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(`${name}:end`)
    }
    await Promise.all([lock('a', step('a')), lock('b', step('b'))])
    expect(events.slice(0, 2)).toEqual(['a:start', 'b:start'])
  })
})

describe('isConcurrentWriteConflict', () => {
  it("matches only the plugin's optimistic-lock 409", async () => {
    expect(await isConcurrentWriteConflict(conflict())).toBe(true)
    expect(
      await isConcurrentWriteConflict(
        scimResponse(409, { detail: 'SCIM User externalId already exists', scimType: 'uniqueness' }),
      ),
    ).toBe(false)
    expect(
      await isConcurrentWriteConflict(scimResponse(409, { detail: 'changed concurrently', scimType: 'uniqueness' })),
    ).toBe(false)
    expect(await isConcurrentWriteConflict(scimResponse(200, { detail: 'changed concurrently' }))).toBe(false)
    expect(await isConcurrentWriteConflict(new Response('not json', { status: 409 }))).toBe(false)
  })
})

describe('sendRetryingConcurrentConflicts', () => {
  it('sends again until the conflict clears', async () => {
    const responses = [conflict(), conflict(), scimResponse(200, { id: 'u1' })]
    let sends = 0
    const response = await sendRetryingConcurrentConflicts(async () => responses[sends++], noWait)
    expect(sends).toBe(3)
    expect(response.status).toBe(200)
  })

  it('never retries a uniqueness conflict', async () => {
    let sends = 0
    const response = await sendRetryingConcurrentConflicts(async () => {
      sends++
      return scimResponse(409, { detail: 'already exists', scimType: 'uniqueness' })
    }, noWait)
    expect(sends).toBe(1)
    expect(response.status).toBe(409)
  })

  it(`gives up after ${concurrentWriteRetries} retries and returns the conflict`, async () => {
    let sends = 0
    const response = await sendRetryingConcurrentConflicts(async () => {
      sends++
      return conflict()
    }, noWait)
    expect(sends).toBe(concurrentWriteRetries + 1)
    expect(response.status).toBe(409)
  })
})
