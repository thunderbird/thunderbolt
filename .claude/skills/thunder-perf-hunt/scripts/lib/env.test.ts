/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from 'vite'
import { backendEnv, frontendEnv, resolveSecret, runtimeEnv } from './env'
import { isolatedFrontendConfig } from './frontend-config'

const stack = {
  backendPort: 8009,
  frontendPort: 1429,
  backendUrl: 'http://127.0.0.1:8009',
  baseUrl: 'http://127.0.0.1:1429',
  databaseDir: '/tmp/scout-fixture',
}
const caller = {
  PATH: '/runtime/bin',
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  ANTHROPIC_API_KEY: 'fixture-provider',
  BETTER_AUTH_SECRET: 'fixture-production-auth',
  RESEND_API_KEY: 'fixture-email',
  POSTHOG_API_KEY: 'fixture-analytics',
  VITE_POSTHOG_KEY: 'fixture-frontend-analytics',
  DATABASE_URL: 'fixture-production-database',
}

it('inherits only runtime paths and pins its own backend, database and frontend configuration', () => {
  expect(runtimeEnv(caller)).toEqual({ PATH: '/runtime/bin' })
  const backend = { ...runtimeEnv(caller), ...backendEnv('fixture-secret', stack, caller) }
  expect(backend).toMatchObject({
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    DATABASE_URL: stack.databaseDir,
    BETTER_AUTH_SECRET: 'fixture-secret',
  })
  for (const key of ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'POSTHOG_API_KEY']) {
    expect(backend[key]).toBeUndefined()
  }
  expect({ ...runtimeEnv(caller), ...frontendEnv(stack) }).not.toHaveProperty('VITE_POSTHOG_KEY')
  expect(resolveSecret().length).toBeGreaterThanOrEqual(32)
  expect(resolveSecret()).not.toBe(resolveSecret())
})

it('forwards only provider credentials after explicit opt-in, never email or analytics credentials', () => {
  const backend = backendEnv('fixture-secret', stack, { ...caller, PERF_HUNT_ALLOW_PROVIDER_CREDENTIALS: 'true' })
  expect(backend.ANTHROPIC_API_KEY).toBe(caller.ANTHROPIC_API_KEY)
  expect(backend.RESEND_API_KEY).toBeUndefined()
  expect(backend.POSTHOG_API_KEY).toBeUndefined()
  expect(backend.BETTER_AUTH_SECRET).toBe('fixture-secret')
})

it('Bun children ignore dotenv files and Vite ignores them independently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'perf-dotenv-'))
  try {
    writeFileSync(join(directory, '.env'), 'PERF_DOTENV_SENTINEL=unexpected\nVITE_PERF_DOTENV_SENTINEL=unexpected\n')
    const child = Bun.spawnSync(
      [process.execPath, '--no-env-file', '-e', 'console.log(process.env.PERF_DOTENV_SENTINEL ?? "absent")'],
      { cwd: directory, env: runtimeEnv() },
    )
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe('absent')
    const config = await resolveConfig(
      { ...isolatedFrontendConfig({ root: directory, logLevel: 'silent' }, stack.frontendPort), configFile: false },
      'serve',
    )
    expect(config.env.VITE_PERF_DOTENV_SENTINEL).toBeUndefined()
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: stack.frontendPort, strictPort: true })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
