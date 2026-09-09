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
