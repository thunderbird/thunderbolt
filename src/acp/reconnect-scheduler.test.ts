/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { ReconnectScheduler } from './reconnect-scheduler'

const flush = async (): Promise<void> => {
  for (let count = 0; count < 10; count++) {
    await Promise.resolve()
  }
}

describe('ReconnectScheduler', () => {
  it('attempts immediately, then uses capped full-jitter backoff', async () => {
    const reconnect = mock(async () => Promise.reject(new Error('offline')))
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      maxAttempts: 3,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('agent', reconnect)

    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(1)
    await getClock().tickAsync(499)
    expect(reconnect).toHaveBeenCalledTimes(1)
    await getClock().tickAsync(1)
    expect(reconnect).toHaveBeenCalledTimes(2)
    await getClock().tickAsync(999)
    expect(reconnect).toHaveBeenCalledTimes(2)
    await getClock().tickAsync(1)
    expect(reconnect).toHaveBeenCalledTimes(3)
    await getClock().runAllAsync()
    expect(reconnect).toHaveBeenCalledTimes(3)
    scheduler.dispose()
  })

  it('pauses while hidden or offline and wakes on browser events', async () => {
    const visibilityTarget = new EventTarget()
    const onlineTarget = new EventTarget()
    const reconnect = mock(async () => {})
    let visible = false
    let online = true
    const scheduler = new ReconnectScheduler({
      isVisible: () => visible,
      isOnline: () => online,
      visibilityTarget,
      onlineTarget,
    })
    scheduler.register('hidden', reconnect)
    await getClock().tickAsync(0)
    expect(reconnect).not.toHaveBeenCalled()

    visible = true
    online = false
    visibilityTarget.dispatchEvent(new Event('visibilitychange'))
    await getClock().tickAsync(0)
    expect(reconnect).not.toHaveBeenCalled()

    online = true
    onlineTarget.dispatchEvent(new Event('online'))
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('coalesces repeated manual wakes into one immediate attempt', async () => {
    const reconnect = mock(async () => {})
    let visible = false
    const scheduler = new ReconnectScheduler({ isVisible: () => visible, isOnline: () => true })
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(0)

    visible = true
    scheduler.wake('agent')
    scheduler.wake('agent')
    scheduler.wake('agent')
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('limits concurrent dials across agents', async () => {
    const releases: Array<() => void> = []
    let active = 0
    let peak = 0
    const reconnect = async (): Promise<void> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
    }
    const scheduler = new ReconnectScheduler({
      maxConcurrent: 2,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('one', reconnect)
    scheduler.register('two', reconnect)
    scheduler.register('three', reconnect)
    await getClock().tickAsync(0)
    await flush()
    expect(active).toBe(2)
    expect(peak).toBe(2)

    releases.shift()?.()
    await flush()
    expect(active).toBe(2)
    expect(peak).toBe(2)
    for (const release of releases) {
      release()
    }
    await flush()
    scheduler.dispose()
  })
})
