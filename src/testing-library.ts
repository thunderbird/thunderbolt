import { afterEach, beforeEach, expect } from 'bun:test'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import type { InstalledClock } from '@sinonjs/fake-timers'

expect.extend(matchers)

// Get the global clock that was installed in happydom.ts
// This ensures fake timers are available before any module loads
// @ts-ignore
const globalClock: InstalledClock = globalThis.__GLOBAL_FAKE_CLOCK__

if (!globalClock) {
  throw new Error('Global fake clock not initialized. happydom.ts must be preloaded first.')
}

beforeEach(() => {
  // Reset the clock to a clean state for each test
  // Don't uninstall/reinstall - just reset to avoid timing issues
  globalClock.reset()
})

afterEach(() => {
  // Clean up React components
  cleanup()
})

/**
 * Get the current global fake clock instance for the test.
 * Use this when you need to manually advance time in tests.
 *
 * @example
 * await act(async () => {
 *   await getClock().runAllAsync()
 * })
 */
export const getClock = (): InstalledClock => {
  return globalClock
}
