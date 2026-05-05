/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db } from '@/db/client'
import type { ObservabilityRecorder } from '@/proxy/observability'
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
  /** OTP request cooldown in milliseconds. Default: 15000 (15s). Set to 0 to disable in tests. */
  otpCooldownMs?: number
  /** WebSocket constructor used by the universal proxy WS relay to open upstream
   *  connections. Tests can inject a fake to keep traffic in-process. Default:
   *  `globalThis.WebSocket`. */
  upstreamWsFactory?: (url: string, protocols?: string[]) => WebSocket
  /** Observability recorder for proxy traffic. Defaults are wired in
   *  `createApp` from the configured Pino logger + PostHog client. Tests pass
   *  a recorder that captures events in-memory. */
  proxyObservability?: ObservabilityRecorder
}
