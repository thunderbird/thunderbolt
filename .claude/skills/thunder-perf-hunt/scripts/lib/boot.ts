/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { http } from '../../../../../src/lib/http'
import { backendEnv, frontendEnv, resolveSecret, runtimeEnv } from './env'
import { allocateStack } from './stack-allocation'

export type BootedStack = { baseUrl: string; teardown: () => Promise<void> }

/** Wait for this run's own server, bounding each request as well as total startup time. */
const waitForUrl = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await http.get(url, { timeout: 1_000 })
      return
    } catch {
      // Connection failures are expected while the child is starting.
    }
    await Bun.sleep(500)
  }
  throw new Error(`perf-hunt: server did not become ready at ${url}`)
}

/** Boot an isolated stack; one scout's teardown never stops another run's servers or database. */
export const bootStack = async (repoRoot: string): Promise<BootedStack> => {
  const stack = await allocateStack()
  const children: Bun.Subprocess[] = []
  const teardown = async () => {
    for (const child of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
    await stack.cleanup()
  }
  try {
    stack.releaseBackendPort()
    children.push(
      Bun.spawn(['bun', '--no-env-file', 'src/index.ts'], {
        cwd: `${repoRoot}/backend`,
        env: { ...runtimeEnv(), ...backendEnv(resolveSecret(), stack, process.env) },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    await waitForUrl(`${stack.backendUrl}/v1/health`, 120_000)
    stack.releaseFrontendPort()
    children.push(
      Bun.spawn(['bun', '--no-env-file', `${repoRoot}/.claude/skills/thunder-perf-hunt/scripts/lib/frontend.ts`], {
        cwd: repoRoot,
        env: { ...runtimeEnv(), ...frontendEnv(stack) },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    await waitForUrl(stack.baseUrl, 120_000)
    return { baseUrl: stack.baseUrl, teardown }
  } catch (error) {
    await teardown()
    throw error
  }
}
