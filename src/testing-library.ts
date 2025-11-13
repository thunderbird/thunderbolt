import { afterEach, beforeEach, expect } from 'bun:test'
import { cleanup, configure } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { installFakeTimers } from '@/test-utils/fake-timers'
import type { InstalledClock } from '@sinonjs/fake-timers'

expect.extend(matchers)

// CRITICAL FIX: Configure @testing-library to not use fake timers
// This prevents @testing-library from trying to call jest.advanceTimersByTime
// which doesn't work reliably in CI
configure({
  // Custom async wrapper that doesn't try to use fake timers
  asyncWrapper: async (cb) => await cb(),
})

// Global fake timers setup - we manage our own
let globalClock: InstalledClock | null = null

beforeEach(() => {
  globalClock = installFakeTimers()
})

afterEach(() => {
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
