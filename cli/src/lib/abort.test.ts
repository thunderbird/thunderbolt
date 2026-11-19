/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { abortable, createSerialQueue, settleBestEffort } from './abort.ts'

describe('async lifecycle helpers', () => {
  test('aborts an operation that ignores its signal', async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers<void>()
    const result = abortable(pending.promise, controller.signal)

    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('prioritizes an existing cancellation and observes a later operation rejection', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('already cancelled', 'AbortError'))
    const pending = Promise.withResolvers<void>()
    const result = abortable(pending.promise, controller.signal)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    pending.reject(new Error('late transport failure'))
    // An unobserved rejection fails the Bun test process on the following turn.
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  test('prioritizes existing cancellation over an already-settled operation', async () => {
    const signal = AbortSignal.abort(new DOMException('already cancelled', 'AbortError'))
    await expect(abortable(Promise.resolve('finished'), signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(abortable(Promise.reject(new Error('transport failed')), signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('serializes operations after an earlier rejection', async () => {
    const queue = createSerialQueue()
    const events: string[] = []
    const releaseFirst = Promise.withResolvers<void>()
    const first = queue.run(async () => {
      events.push('first')
      await releaseFirst.promise
      throw new Error('failed')
    })
    const second = queue.run(async () => {
      events.push('second')
    })

    await Promise.resolve()
    expect(events).toEqual(['first'])

    releaseFirst.resolve()
    await settleBestEffort(first)
    await second

    expect(events).toEqual(['first', 'second'])
  })
})
