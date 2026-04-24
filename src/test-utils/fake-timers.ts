import { type Clock, install } from '@sinonjs/fake-timers'

/**
 * Creates and installs fake timers for testing.
 * Returns a clock object that can be used to control time.
 *
 * Also sets up Jest-compatible API for @testing-library/react compatibility.
 *
 * @example
 * const clock = installFakeTimers()
 * // ... test code ...
 * await clock.tickAsync(1000) // advance time by 1 second
 * clock.uninstall()
 */
export const installFakeTimers = (config?: { now?: number; shouldAdvanceTime?: boolean }): Clock => {
  const clock = install({
    now: config?.now ?? Date.now(),
    shouldAdvanceTime: config?.shouldAdvanceTime ?? false,
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  })

  // Update Jest-compatible API implementations
  // CRITICAL: We must UPDATE the existing jest object, not replace it
  // because @testing-library/react may have already captured a reference
  // @ts-ignore
  const jestGlobal = globalThis.jest || global.jest

  if (jestGlobal) {
    jestGlobal.advanceTimersByTime = (ms: number) => clock.tick(ms)
    jestGlobal.runAllTimers = () => clock.runAll()
    jestGlobal.runOnlyPendingTimers = () => clock.runToLast()
    jestGlobal.clearAllTimers = () => clock.reset()
    jestGlobal.getTimerCount = () => clock.countTimers()
  } else {
    // Fallback: create new object if it doesn't exist
    const jestImpl = {
      advanceTimersByTime: (ms: number) => clock.tick(ms),
      runAllTimers: () => clock.runAll(),
      runOnlyPendingTimers: () => clock.runToLast(),
      clearAllTimers: () => clock.reset(),
      getTimerCount: () => clock.countTimers(),
    }
    // @ts-ignore
    globalThis.jest = jestImpl
    // @ts-ignore
    global.jest = jestImpl
  }

  return clock
}
