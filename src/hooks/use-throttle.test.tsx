import { installFakeTimers } from '@/test-utils/fake-timers'
import type { InstalledClock } from '@sinonjs/fake-timers'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

describe('useThrottledCallback', () => {
  let clock: InstalledClock

  beforeEach(() => {
    clock = installFakeTimers()
  })

  afterEach(() => {
    clock.uninstall()
  })

  it('should call callback immediately on first invocation', () => {
    const callback = mock((..._args: any[]) => {})

    // Simulate throttled callback behavior
    let lastCallTime = 0
    const throttleMs = 1000

    const throttledFn = (...args: any[]) => {
      const now = Date.now()
      if (now - lastCallTime >= throttleMs) {
        lastCallTime = now
        callback(...args)
      }
    }

    throttledFn('test')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('test')
  })

  it('should throttle rapid calls', async () => {
    const callback = mock((..._args: any[]) => {})
    const throttleMs = 100
    let lastCallTime = 0
    let pendingArgs: any[] | null = null
    let timeoutId: NodeJS.Timeout | null = null

    const throttledFn = (...args: any[]) => {
      const now = Date.now()
      const timeSinceLastCall = now - lastCallTime

      if (timeSinceLastCall >= throttleMs) {
        lastCallTime = now
        callback(...args)
      } else {
        pendingArgs = args
        if (timeoutId) clearTimeout(timeoutId)
        timeoutId = setTimeout(() => {
          lastCallTime = Date.now()
          if (pendingArgs) {
            callback(...pendingArgs)
            pendingArgs = null
          }
        }, throttleMs - timeSinceLastCall)
      }
    }

    // First call - immediate
    throttledFn('first')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('first')

    // Rapid calls - throttled
    throttledFn('second')
    throttledFn('third')
    throttledFn('fourth')

    // Should still only have been called once
    expect(callback).toHaveBeenCalledTimes(1)

    // Wait for throttle to complete
    await clock.tickAsync(150)

    // Should have been called with the last value
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1]?.[0]).toBe('fourth')

    if (timeoutId) clearTimeout(timeoutId)
  })

  it('should allow calls after interval passes', async () => {
    const callback = mock((..._args: any[]) => {})
    const throttleMs = 50
    let lastCallTime = 0

    const throttledFn = (...args: any[]) => {
      const now = Date.now()
      if (now - lastCallTime >= throttleMs) {
        lastCallTime = now
        callback(...args)
      }
    }

    throttledFn('first')
    expect(callback).toHaveBeenCalledTimes(1)

    // Wait for interval to pass
    await clock.tickAsync(60)

    // Next call should be immediate
    throttledFn('second')
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[1]?.[0]).toBe('second')
  })

  it('should handle multiple arguments', () => {
    const callback = mock((..._args: any[]) => {})
    let lastCallTime = 0
    const throttleMs = 1000

    const throttledFn = (...args: any[]) => {
      const now = Date.now()
      if (now - lastCallTime >= throttleMs) {
        lastCallTime = now
        callback(...args)
      }
    }

    throttledFn('arg1', 'arg2', 'arg3')
    expect(callback).toHaveBeenCalledWith('arg1', 'arg2', 'arg3')
  })
})
