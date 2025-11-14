import { installFakeTimers } from '@/test-utils/fake-timers'
import type { InstalledClock } from '@sinonjs/fake-timers'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, beforeEach, expect } from 'bun:test'
import { clearMemoizeCache } from '@/lib/memoize'

expect.extend(matchers)

// CRITICAL FIX: Configure @testing-library to not use fake timers
// This prevents @testing-library from trying to call jest.advanceTimersByTime
// which doesn't work reliably in CI
configure({
  // Custom async wrapper that doesn't try to use fake timers
  asyncWrapper: async (cb) => await cb(),
})

// Suppress console errors/warnings during tests to reduce noise
// These are typically expected errors from testing error handling paths
const originalConsoleError = console.error
const originalConsoleWarn = console.warn

// Suppress console.error and console.warn globally
console.error = () => {}
console.warn = () => {}

/**
 * Restore the original console.error and console.warn functions.
 * Use this in tests where you need to verify console output or debug issues.
 *
 * @example
 * import { restoreConsole } from '@/testing-library'
 *
 * test('should log error', () => {
 *   restoreConsole()
 *   // ... test that expects console.error to be called
 * })
 */
export const restoreConsole = () => {
  console.error = originalConsoleError
  console.warn = originalConsoleWarn
}

/**
 * Suppress console.error and console.warn output.
 * This is automatically called in beforeEach, but can be used manually
 * if you restored console during a test and want to suppress it again.
 */
export const suppressConsole = () => {
  console.error = () => {}
  console.warn = () => {}
}

// Global fake timers setup - we manage our own
let globalClock: InstalledClock | null = null

// Mock jest global for @testing-library/dom's waitFor which tries to use jest.advanceTimersByTime
// This must be defined after globalClock so it can access it
;(globalThis as { jest?: { advanceTimersByTime: (ms: number) => void } }).jest = {
  advanceTimersByTime: (ms: number) => {
    if (globalClock) {
      globalClock.tick(ms)
    }
  },
}

beforeEach(() => {
  globalClock = installFakeTimers()
  // Ensure console is suppressed for each test
  suppressConsole()
  // Clear memoized values to prevent pollution between tests
  clearMemoizeCache()
})

afterEach(() => {
  if (globalClock) {
    // Clear all pending timers before uninstalling to prevent pollution
    try {
      globalClock.reset()
    } catch (e) {
      // Ignore errors during cleanup
    }
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
