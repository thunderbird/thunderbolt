import type { Auth } from '@/auth/auth'
import type { db } from '@/db/client'
import type { WaitlistEmailService } from '@/waitlist/routes'

/**
 * Standard dependencies for Elysia app creation
 * Allows injecting test implementations for integration testing
 */
export type AppDeps = {
  fetchFn?: typeof fetch
  database?: typeof db
  auth?: Auth
  waitlistEmailService?: WaitlistEmailService
}
