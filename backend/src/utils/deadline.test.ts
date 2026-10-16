/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { withDeadline } from './deadline'

/** Whether `signal` aborts within `ms`. */
const abortsWithin = async (signal: AbortSignal, ms: number): Promise<boolean> => {
  const outcome = Promise.withResolvers<boolean>()
  signal.addEventListener('abort', () => outcome.resolve(true), { once: true })
  const timer = setTimeout(() => outcome.resolve(false), ms)
  const aborted = await outcome.promise
  clearTimeout(timer)
  return aborted
}

describe('withDeadline', () => {
  it("returns the work's value", async () => {
    expect(await withDeadline(1_000, async () => 'done')).toBe('done')
  })

  it('aborts the signal with a TimeoutError once the time is up', async () => {
    const reason: unknown = await withDeadline(20, async (signal) => {
      await abortsWithin(signal, 1_000)
      return signal.reason
    })
    expect(reason instanceof DOMException && reason.name).toBe('TimeoutError')
  })

  it('fires after its last listener is removed, which an AbortSignal.timeout does not on Bun 1.3', async () => {
    const fired = await withDeadline(20, (signal) => {
      const listener = () => {}
      signal.addEventListener('abort', listener)
      signal.removeEventListener('abort', listener)
      return abortsWithin(signal, 1_000)
    })
    expect(fired).toBe(true)
  })

  it('stops the timer once the work settles, so its signal never aborts after', async () => {
    const signal = await withDeadline(20, async (deadline) => deadline)
    expect(await abortsWithin(signal, 60)).toBe(false)
  })

  it('stops the timer when the work throws', async () => {
    const signals: AbortSignal[] = []
    const failing = withDeadline(20, async (deadline) => {
      signals.push(deadline)
      throw new Error('work failed')
    })
    await expect(failing).rejects.toThrow('work failed')
    expect(await abortsWithin(signals[0], 60)).toBe(false)
  })
})
