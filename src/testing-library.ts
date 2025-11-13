import { afterEach, beforeEach, expect } from 'bun:test'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { installFakeTimers } from '@/test-utils/fake-timers'
import type { InstalledClock } from '@sinonjs/fake-timers'

expect.extend(matchers)

// CRITICAL FIX: Disable @testing-library/react's fake timer detection
// This prevents it from trying to use jest.advanceTimersByTime
// We'll manage our own fake timers instead
// @ts-ignore - monkey-patch the internal function that checks for fake timers
const rtl = await import('@testing-library/react')
if (rtl && typeof rtl === 'object') {
  // Find and disable jestFakeTimersAreEnabled
  Object.defineProperty(globalThis, 'jestFakeTimersAreEnabled', {
    value: () => false,
    writable: false,
    configurable: false,
  })
}

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
