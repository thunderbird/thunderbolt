/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Boot configuration for a perf-hunt run. We bind to dedicated ports (off the
 * `make dev` band of 1420/8000 and off the e2e band of 1421-1422/8002-8003) so a
 * perf run never collides with a dev server or the e2e suite. Auth uses the
 * anonymous auto-session path (no Docker, no mock IdP, no magic-link scraping):
 * the AuthGate silently creates a session and lands on /chats/new.
 */

export const PERF_FRONTEND_PORT = 1431
export const PERF_BACKEND_PORT = 8010

export const PERF_BASE_URL = `http://localhost:${PERF_FRONTEND_PORT}`
export const PERF_BACKEND_URL = `http://localhost:${PERF_BACKEND_PORT}`

/**
 * Backend env for an anonymous, Docker-free stack. BETTER_AUTH_SECRET must be
 * at least 32 chars; a stable dev secret is fine because pglite data is
 * throwaway. An AI provider key is read from the caller's environment if set
 * (chat streaming scenarios need it); perf runs that never send a message work
 * without one.
 */
export const backendEnv = (secret: string): Record<string, string> => ({
  PORT: String(PERF_BACKEND_PORT),
  AUTH_MODE: 'consumer',
  AUTH_ALLOW_ANONYMOUS: 'true',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: '.pglite/perf-hunt',
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: PERF_BACKEND_URL,
  APP_URL: PERF_BASE_URL,
  CORS_ORIGINS: PERF_BASE_URL,
  TRUSTED_ORIGINS: PERF_BASE_URL,
  RATE_LIMIT_ENABLED: 'false',
})

/** Frontend (Vite) env for the anonymous auto-session, onboarding skipped. */
export const frontendEnv = (): Record<string, string> => ({
  VITE_AUTH_ENABLE_ANONYMOUS: 'true',
  VITE_BYPASS_WAITLIST: 'true',
  VITE_SKIP_ONBOARDING: 'true',
  VITE_THUNDERBOLT_CLOUD_URL: `${PERF_BACKEND_URL}/v1`,
})

/** A 32+ char secret: caller's BETTER_AUTH_SECRET or a stable throwaway. */
export const resolveSecret = (): string =>
  process.env.BETTER_AUTH_SECRET ?? 'perf-hunt-throwaway-secret-at-least-32-characters'

export const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname
