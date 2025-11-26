import type { db } from '@/db/client'

/**
 * Standard dependencies for Elysia app creation
 * Allows injecting test implementations for integration testing
 */
export type AppDeps = {
  fetchFn?: typeof fetch
  database?: typeof db
}
