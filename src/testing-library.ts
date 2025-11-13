import { afterEach, beforeEach, expect } from 'bun:test'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { installFakeTimers } from '@/test-utils/fake-timers'
import type { InstalledClock } from '@sinonjs/fake-timers'

expect.extend(matchers)

// Global fake timers setup - installed before each test
let globalClock: InstalledClock | null = null

// Set up jest global immediately so @testing-library/react can detect fake timers
// The actual implementations will be replaced in beforeEach
// @ts-ignore
globalThis.jest = {
  advanceTimersByTime: () => {
    throw new Error('Fake timers not initialized. This should not happen.')
  },
  runAllTimers: () => {
    throw new Error('Fake timers not initialized. This should not happen.')
  },
  runOnlyPendingTimers: () => {
    throw new Error('Fake timers not initialized. This should not happen.')
  },
  clearAllTimers: () => {
    throw new Error('Fake timers not initialized. This should not happen.')
  },
  getTimerCount: () => 0,
}

beforeEach(() => {
  globalClock = installFakeTimers()
})

afterEach(() => {
  // Clean up fake timers before cleaning up React components
  // Note: We don't delete globalThis.jest because it needs to persist for @testing-library/react
  if (globalClock) {
    globalClock.uninstall()
    globalClock = null
  }
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
  if (!globalClock) {
    throw new Error('Clock is not installed. This should not happen in tests.')
  }
  return globalClock
}
