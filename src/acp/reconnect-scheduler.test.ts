/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { describe, expect, it, mock, spyOn } from 'bun:test'
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

  it('keeps recovery registered when a replacement dies during the completed attempt', async () => {
    const scheduled: Array<() => void> = []
    const replacementReconnect = mock(async () => Promise.reject(new Error('replacement offline')))
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      random: () => 1,
      isVisible: () => true,
      isOnline: () => true,
      setTimer: ((callback: TimerHandler) => {
        scheduled.push(callback as () => void)
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
    })
    const reconnect = mock(async () => {
      scheduler.register('agent', replacementReconnect)
    })

    scheduler.register('agent', reconnect)
    scheduled.shift()?.()
    await flush()
    scheduled.shift()?.()
    await flush()

    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(replacementReconnect).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('continues the backoff progression when each fresh connection dies inside the stability window', async () => {
    const reconnect = mock(async () => {})
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
      stabilityWindowMs: 30_000,
    })
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(1)

    // The immediate attempt succeeded, but the connection died 5s later —
    // inside the window — so re-registering keeps draining the retry budget
    // (attempt 1: 0.5 * 1000ms) instead of earning another 0ms redial.
    await getClock().tickAsync(5_000)
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(499)
    expect(reconnect).toHaveBeenCalledTimes(1)
    await getClock().tickAsync(1)
    expect(reconnect).toHaveBeenCalledTimes(2)

    // Another success-then-instant-death cycle moves further along the
    // progression (attempt 2: 0.5 * 2000ms).
    await getClock().tickAsync(5_000)
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(999)
    expect(reconnect).toHaveBeenCalledTimes(2)
    await getClock().tickAsync(1)
    expect(reconnect).toHaveBeenCalledTimes(3)
    scheduler.dispose()
  })

  it('resets the retry budget once a connection stays up past the stability window', async () => {
    const reconnect = mock(async () => {})
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
      stabilityWindowMs: 30_000,
    })
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(1)

    // The connection proved stable, so the next failure starts fresh with an
    // immediate attempt.
    await getClock().tickAsync(31_000)
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('warns on each failed attempt and errors when recovery pauses after maxAttempts', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const reconnect = mock(async () => Promise.reject(new Error('offline')))
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      maxAttempts: 2,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('agent', reconnect)

    await getClock().runAllAsync()

    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('ACP background reconnect attempt failed', 'agent', 1, expect.any(Error))
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      'ACP background recovery paused after exhausting attempts; will retry on tab refocus, network recovery, or manual retry',
      'agent',
    )
    scheduler.dispose()
  })

  it('grants an exhausted recovery exactly one coalesced attempt on a browser-event wake', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const reconnect = mock(async () => Promise.reject(new Error('offline')))
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      maxAttempts: 2,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('agent', reconnect)
    await getClock().runAllAsync()
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(1)

    scheduler.wake()
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(3)

    // The granted attempt failed, so the budget re-exhausts at once: no
    // further backoff retries are scheduled and the pause is logged again.
    await getClock().runAllAsync()
    expect(reconnect).toHaveBeenCalledTimes(3)
    expect(error).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('fully resets a non-exhausted recovery on a browser-event wake', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const reconnect = mock(async () => Promise.reject(new Error('offline')))
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      maxAttempts: 3,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('agent', reconnect)
    await getClock().tickAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(1)

    // One failure already drained one attempt; a browser-event wake before
    // the backoff fires still restarts the full budget.
    scheduler.wake()
    await getClock().runAllAsync()

    expect(reconnect).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenNthCalledWith(2, 'ACP background reconnect attempt failed', 'agent', 1, expect.any(Error))
    expect(error).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('fully resets an exhausted recovery on a manual wake', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const reconnect = mock(async () => Promise.reject(new Error('offline')))
    const scheduler = new ReconnectScheduler({
      baseDelayMs: 1_000,
      maxAttempts: 2,
      random: () => 0.5,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('agent', reconnect)
    await getClock().runAllAsync()
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(1)

    // Manual Retry (wakeAdapterReconnect) re-grants the full budget.
    scheduler.wake('agent')
    await getClock().runAllAsync()

    expect(reconnect).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('keeps an exhausted record registered so a later wake can revive it', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const exhaustedReconnect = mock(async () => Promise.reject(new Error('offline')))
    const removedReconnect = mock(async () => Promise.reject(new Error('offline')))
    const scheduler = new ReconnectScheduler({
      maxAttempts: 1,
      isVisible: () => true,
      isOnline: () => true,
    })
    scheduler.register('exhausted', exhaustedReconnect)
    scheduler.register('removed', removedReconnect)
    scheduler.unregister('removed')
    await getClock().runAllAsync()
    expect(exhaustedReconnect).toHaveBeenCalledTimes(1)
    expect(removedReconnect).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)

    // Exhaustion must not free the record: a browser-event wake still
    // reaches it, while the explicitly unregistered record stays untouched.
    scheduler.wake()
    await getClock().runAllAsync()
    expect(exhaustedReconnect).toHaveBeenCalledTimes(2)
    expect(removedReconnect).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })
})
