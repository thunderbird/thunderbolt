/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearAuthToken, clearDeviceId, clearUserCacheSecret } from '@/lib/auth-token'
import { clearMemoizeCache } from '@/lib/memoize'
import { installFakeTimers } from '@/test-utils/fake-timers'
import * as linguiMacros from '@/i18n/identity-macros'
import type { Clock } from '@sinonjs/fake-timers'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, beforeEach, expect, mock } from 'bun:test'

// Lingui macros are compiled away by Babel in the Vite build, but bun test
// never runs Babel — swap in identity implementations that render the English
// source text so `getByText` assertions keep passing (see src/i18n/identity-macros.tsx).
mock.module('@lingui/react/macro', () => ({
  Trans: linguiMacros.Trans,
  Plural: linguiMacros.Plural,
  useLingui: linguiMacros.useLingui,
}))

mock.module('@lingui/core/macro', () => ({
  t: linguiMacros.t,
  plural: linguiMacros.plural,
  msg: linguiMacros.msg,
  defineMessage: linguiMacros.defineMessage,
}))

// `src/i18n/index.ts` imports the compiled source catalog statically so first
// paint has real English text. Vite compiles `.po` through @lingui/vite-plugin;
// bun has no such loader, so the import fails to resolve and every test file
// that reaches `@/i18n` dies with "Export named 'messages' not found". An empty
// catalog is the honest stand-in: the identity macros above mean no test reads
// a catalog anyway, so there is nothing here for a real one to make truer.
mock.module('@/locales/en/messages.po', () => ({ messages: {} }))

/** Global spy for web-haptics' `trigger` — assert on it to verify haptic
 *  calls (see surface-haptics.test.tsx). Cleared automatically in beforeEach. */
export const webHapticsTriggerMock = mock(() => Promise.resolve())

// Mock web-haptics/react globally — no vibration API in test environment
mock.module('web-haptics/react', () => ({
  useWebHaptics: () => ({ trigger: webHapticsTriggerMock }),
}))

// Mock posthog-js globally to prevent browser detection errors in tests
// PostHog tries to access browser APIs like navigator.userAgent.match() during module load,
// which fails in Happy-DOM's test environment
mock.module('posthog-js', () => ({
  default: {
    init: () => null,
    capture: () => {},
    identify: () => {},
    reset: () => {},
    opt_out_capturing: () => {},
    opt_in_capturing: () => {},
    has_opted_out_capturing: () => false,
    get_distinct_id: () => 'test-distinct-id',
    captureException: () => {},
  },
}))

expect.extend(matchers)

// CRITICAL FIX: Configure @testing-library to not use fake timers
// This prevents @testing-library from trying to call jest.advanceTimersByTime
// which doesn't work reliably in CI
configure({
  // Custom async wrapper that doesn't try to use fake timers
  asyncWrapper: async (cb) => await cb(),
})

// Suppress console output during tests to reduce noise
// These are typically expected from testing or normal operations
const originalConsoleError = console.error
const originalConsoleWarn = console.warn
const originalConsoleInfo = console.info

// Suppress console methods globally (but not console.log for debugging)
console.error = () => {}
console.warn = () => {}
console.info = () => {}

/**
 * Restore the original console functions.
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
  console.info = originalConsoleInfo
}

/**
 * Suppress console output.
 * This is automatically called in beforeEach, but can be used manually
 * if you restored console during a test and want to suppress it again.
 */
export const suppressConsole = () => {
  console.error = () => {}
  console.warn = () => {}
  console.info = () => {}
}

// Global fake timers setup - we manage our own
let globalClock: Clock | null = null

// Mock jest global for @testing-library/dom's waitFor which tries to use jest.advanceTimersByTime
// This must be defined after globalClock so it can access it
const existingJest = (globalThis as any).jest || {}
;(globalThis as any).jest = {
  ...existingJest,
  advanceTimersByTime: (ms: number) => {
    if (globalClock) {
      globalClock.tick(ms)
    }
  },
}

beforeEach(() => {
  globalClock = installFakeTimers()
  webHapticsTriggerMock.mockClear()
  // Ensure console is suppressed for each test
  suppressConsole()
  // Clear memoized values to prevent pollution between tests
  clearMemoizeCache()
})

afterEach(() => {
  if (globalClock) {
    // Clear all pending timers before uninstalling to prevent pollution
    globalClock.reset()
    globalClock.uninstall()
    globalClock = null
  }
  cleanup()
  // Backstop against cross-file auth-token leakage: any test that leaves a token
  // in localStorage would otherwise make AuthProvider's mount effect fire an extra
  // get-session call against the next file's HTTP client.
  clearAuthToken()
  clearDeviceId()
  clearUserCacheSecret()
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
export const getClock = (): Clock => {
  if (!globalClock) {
    throw new Error('Clock is not installed. This should not happen in tests.')
  }
  return globalClock
}
