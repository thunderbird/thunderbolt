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

  // Update Jest-compatible API implementations for @testing-library/react compatibility
  // @ts-ignore
  globalThis.jest.advanceTimersByTime = (ms: number) => clock.tick(ms)
  // @ts-ignore
  globalThis.jest.runAllTimers = () => clock.runAll()
  // @ts-ignore
  globalThis.jest.runOnlyPendingTimers = () => clock.runToLast()
  // @ts-ignore
  globalThis.jest.clearAllTimers = () => clock.reset()
  // @ts-ignore
  globalThis.jest.getTimerCount = () => clock.countTimers()

  return clock
}
