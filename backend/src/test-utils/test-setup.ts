/**
 * Global test setup
 *
 * This file is preloaded before any tests run to initialize expensive resources.
 * Add it to bunfig.toml preload array to ensure it runs first.
 */
import { testDbManager } from './db'

// Disable rate limiting in tests: RateLimiterDrizzle uses its own internal
// queries that bypass PGlite transaction isolation, which breaks test cleanup
process.env.RATE_LIMIT_ENABLED = 'false'

// Force deterministic Better Auth secret for tests — must override any .env value
// so that test signToken() helpers produce matching signatures
process.env.BETTER_AUTH_SECRET = 'better-auth-secret-12345678901234567890'

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
