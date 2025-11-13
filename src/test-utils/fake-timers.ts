import { type InstalledClock, install } from '@sinonjs/fake-timers'

/**
 * Creates and installs fake timers for testing.
 * Returns a clock object that can be used to control time.
 *
 * @example
 * const clock = installFakeTimers()
 * // ... test code ...
 * await clock.tickAsync(1000) // advance time by 1 second
 * clock.uninstall()
 */
export const installFakeTimers = (config?: { now?: number; shouldAdvanceTime?: boolean }): InstalledClock => {
  // Get the real current time before installing fake timers
  const realNow = config?.now ?? Date.now()

  return install({
    now: realNow,
    shouldAdvanceTime: config?.shouldAdvanceTime ?? false,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
}
