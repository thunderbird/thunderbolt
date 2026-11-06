/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Per-run anonymous backend/frontend configuration, isolated from other scouts and dev servers. */

import type { StackAllocation } from './stack-allocation'

/**
 * Backend env for an anonymous, Docker-free stack. BETTER_AUTH_SECRET must be
 * at least 32 chars; a stable dev secret is fine because pglite data is
 * throwaway. An AI provider key is read from the caller's environment if set
 * (chat streaming scenarios need it); perf runs that never send a message work
 * without one.
 */
export const backendEnv = (
  secret: string,
  stack: Pick<StackAllocation, 'backendPort' | 'backendUrl' | 'baseUrl' | 'databaseDir'>,
): Record<string, string> => ({
  PORT: String(stack.backendPort),
  AUTH_MODE: 'consumer',
  AUTH_ALLOW_ANONYMOUS: 'true',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: stack.databaseDir,
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: stack.backendUrl,
  APP_URL: stack.baseUrl,
  CORS_ORIGINS: stack.baseUrl,
  TRUSTED_ORIGINS: stack.baseUrl,
  RATE_LIMIT_ENABLED: 'false',
})

/** Frontend (Vite) env for the anonymous auto-session, onboarding skipped. */
export const frontendEnv = (stack: Pick<StackAllocation, 'backendUrl'>): Record<string, string> => ({
  VITE_AUTH_ENABLE_ANONYMOUS: 'true',
  VITE_BYPASS_WAITLIST: 'true',
  VITE_SKIP_ONBOARDING: 'true',
  VITE_THUNDERBOLT_CLOUD_URL: `${stack.backendUrl}/v1`,
})

/** A 32+ char secret: caller's BETTER_AUTH_SECRET or a stable throwaway. */
export const resolveSecret = (): string =>
  process.env.BETTER_AUTH_SECRET ?? 'perf-hunt-throwaway-secret-at-least-32-characters'

export const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname
