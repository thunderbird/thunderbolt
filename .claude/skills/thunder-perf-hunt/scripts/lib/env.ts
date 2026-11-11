/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Per-run anonymous backend/frontend configuration, isolated from other scouts and dev servers. */

import type { StackAllocation } from './stack-allocation'

/** Select only explicit process inputs, never the caller's whole environment. */
const selectEnv = (source: NodeJS.ProcessEnv, keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key]
      return value === undefined ? [] : [[key, value] as const]
    }),
  )

/** Keep runtime paths needed to launch children, excluding credentials and application configuration. */
export const runtimeEnv = (source: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  selectEnv(source, [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'LOCALAPPDATA',
    'APPDATA',
    'XDG_CACHE_HOME',
  ])

/** Backend configuration; AI/search credentials require an explicit opt-in for this scout. */
export const backendEnv = (
  secret: string,
  stack: Pick<StackAllocation, 'backendPort' | 'backendUrl' | 'baseUrl' | 'databaseDir'>,
  source: NodeJS.ProcessEnv = {},
): Record<string, string> => ({
  ...(source.PERF_HUNT_ALLOW_PROVIDER_CREDENTIALS === 'true'
    ? selectEnv(source, [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'FIREWORKS_API_KEY',
        'TINFOIL_API_KEY',
        'TINFOIL_ENCLAVE_URL',
        'EXA_API_KEY',
      ])
    : {}),
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  OTEL_SDK_DISABLED: 'true',
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
export const frontendEnv = (stack: Pick<StackAllocation, 'backendUrl' | 'frontendPort'>): Record<string, string> => ({
  PORT: String(stack.frontendPort),
  NODE_ENV: 'development',
  VITE_AUTH_ENABLE_ANONYMOUS: 'true',
  VITE_BYPASS_WAITLIST: 'true',
  VITE_SKIP_ONBOARDING: 'true',
  VITE_THUNDERBOLT_CLOUD_URL: `${stack.backendUrl}/v1`,
})

/** Each disposable database gets its own throwaway auth secret, never the caller's production secret. */
export const resolveSecret = (): string => crypto.randomUUID()

export const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname
