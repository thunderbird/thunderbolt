import { type InstalledClock, install } from '@sinonjs/fake-timers'

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
export const installFakeTimers = (config?: { now?: number; shouldAdvanceTime?: boolean }): InstalledClock => {
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

  // Update the jest timer implementation that was set up in happydom.ts
  // This allows @testing-library/react (which captured the jest global at load time)
  // to use the correct timer functions
  // @ts-ignore
  const impl = globalThis.__jestTimerImpl
  if (impl) {
    impl.advanceTimersByTime = (ms: number) => clock.tick(ms)
    impl.runAllTimers = () => clock.runAll()
    impl.runOnlyPendingTimers = () => clock.runToLast()
    impl.clearAllTimers = () => clock.reset()
    impl.getTimerCount = () => clock.countTimers()
  }

  // Wrap uninstall to clear the jest timer implementation
  const originalUninstall = clock.uninstall.bind(clock)
  clock.uninstall = () => {
    if (impl) {
      impl.advanceTimersByTime = null
      impl.runAllTimers = null
      impl.runOnlyPendingTimers = null
      impl.clearAllTimers = null
      impl.getTimerCount = null
    }
    originalUninstall()
  }

  return clock
}
