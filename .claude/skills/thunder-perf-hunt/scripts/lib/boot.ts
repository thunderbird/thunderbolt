/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PERF_BACKEND_PORT, PERF_BACKEND_URL, PERF_BASE_URL, PERF_FRONTEND_PORT, backendEnv, frontendEnv, resolveSecret } from './env'

/**
 * Boots the Docker-free perf stack: a pglite backend and a Vite frontend on
 * dedicated ports, both configured for the anonymous auto-session. Returns a
 * teardown that kills both. Idempotent-ish: if the ports are already serving
 * (a warm stack from a previous run), we reuse them instead of respawning.
 */
export type BootedStack = { baseUrl: string; teardown: () => Promise<void> }

const waitForUrl = async (url: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 401 || res.status === 404) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const isServing = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url)
    return res.ok || res.status === 401 || res.status === 404
  } catch {
    return false
  }
}

export const bootStack = async (repoRoot: string): Promise<BootedStack> => {
  const backendHealth = `${PERF_BACKEND_URL}/v1/health`
  const already = (await isServing(backendHealth)) && (await isServing(PERF_BASE_URL))
  if (already) {
    return { baseUrl: PERF_BASE_URL, teardown: async () => {} }
  }

  const secret = resolveSecret()
  const backend = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: `${repoRoot}/backend`,
    env: { ...process.env, ...backendEnv(secret) },
    // Readiness is polled via waitForUrl, and nothing consumes these streams —
    // 'pipe' would let the ~64KB OS buffer fill and hang the chatty dev server.
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const backendOk = await waitForUrl(backendHealth, 120_000)
  if (!backendOk) {
    backend.kill()
    throw new Error(`perf-hunt: backend did not become healthy on :${PERF_BACKEND_PORT}`)
  }

  const frontend = Bun.spawn(['bun', 'run', 'dev', '--', '--port', String(PERF_FRONTEND_PORT), '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, ...frontendEnv() },
    // Readiness is polled via waitForUrl, and nothing consumes these streams —
    // 'pipe' would let the ~64KB OS buffer fill and hang the chatty dev server.
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const frontendOk = await waitForUrl(PERF_BASE_URL, 120_000)
  if (!frontendOk) {
    frontend.kill()
    backend.kill()
    throw new Error(`perf-hunt: frontend did not become ready on :${PERF_FRONTEND_PORT}`)
  }

  return {
    baseUrl: PERF_BASE_URL,
    teardown: async () => {
      frontend.kill()
      backend.kill()
    },
  }
}
