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

  // Set up Jest-compatible API for @testing-library/react compatibility
  // We define the jest global only when fake timers are installed
  // This prevents @testing-library from trying to use fake timers when they're not available
  // @ts-ignore
  globalThis.jest = {
    advanceTimersByTime: (ms: number) => clock.tick(ms),
    runAllTimers: () => clock.runAll(),
    runOnlyPendingTimers: () => clock.runToLast(),
    clearAllTimers: () => clock.reset(),
    getTimerCount: () => clock.countTimers(),
  }

  // Wrap uninstall to remove the jest global
  const originalUninstall = clock.uninstall.bind(clock)
  clock.uninstall = () => {
    // @ts-ignore
    delete globalThis.jest
    originalUninstall()
  }

  return clock
}
