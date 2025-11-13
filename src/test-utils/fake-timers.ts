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

  // Ensure jest global exists (should be created in happydom.ts, but recreate if missing)
  // @ts-ignore
  if (!globalThis.jest || typeof globalThis.jest !== 'object') {
    // @ts-ignore
    globalThis.jest = {}
  }
  // @ts-ignore
  if (!global.jest || typeof global.jest !== 'object') {
    // @ts-ignore
    global.jest = {}
  }

  // Update Jest-compatible API implementations for @testing-library/react compatibility
  // Update both globalThis.jest and global.jest for maximum compatibility
  const jestImpl = {
    advanceTimersByTime: (ms: number) => clock.tick(ms),
    runAllTimers: () => clock.runAll(),
    runOnlyPendingTimers: () => clock.runToLast(),
    clearAllTimers: () => clock.reset(),
    getTimerCount: () => clock.countTimers(),
  }

  // @ts-ignore
  Object.assign(globalThis.jest, jestImpl)
  // @ts-ignore
  Object.assign(global.jest, jestImpl)

  return clock
}
