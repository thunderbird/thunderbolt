import { afterEach, beforeEach, expect } from 'bun:test'
import { cleanup, configure as configureReactTesting } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { installFakeTimers } from '@/test-utils/fake-timers'
import type { InstalledClock } from '@sinonjs/fake-timers'

expect.extend(matchers)

// Configure @testing-library to work with our fake timers
// This prevents it from trying to use Jest's timer APIs
configureReactTesting({
  asyncWrapper: async (cb) => {
    // Just run the callback without trying to call jest.advanceTimersByTime
    return await cb()
  },
})

// Global fake timers setup - installed before each test
let globalClock: InstalledClock | null = null

// Note: globalThis.jest is set up in happydom.ts (preloaded first)
// to ensure it exists before @testing-library/react checks for it

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
