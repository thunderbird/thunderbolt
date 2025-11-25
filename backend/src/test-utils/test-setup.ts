/**
 * Global test setup
 *
 * This file is preloaded before any tests run to initialize expensive resources.
 * Add it to bunfig.toml preload array to ensure it runs first.
 */
import { testDbManager } from './db'

// Initialize the database before any tests run
console.log('🔧 Initializing test database...')
await testDbManager.initialize()
console.log('✅ Test database ready')

// Mock global fetch to catch accidental network calls in tests
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (...args: Parameters<typeof fetch>) => {
    const url = args[0] instanceof Request ? args[0].url : args[0]?.toString()
    throw new Error(
      `Attempted to call fetch("${url}") in a test. Please use dependency injection (pass fetchFn to createApp) instead.`,
    )
  },
  { preconnect: () => {} }, // Mock the preconnect method that Bun's fetch has
)

// Store original for tests that need to opt-in
;(globalThis as any).__originalFetch = originalFetch
