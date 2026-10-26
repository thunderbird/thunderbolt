/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// stack.sh's port handling: where it reads its ports, what it refuses, and which stack `stop` stops. No test starts a
// server: every case ends before the first one would.

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stackURLs } from '../ports'

const stack = join(import.meta.dir, 'stack.sh')
const work = mkdtempSync(join(tmpdir(), 'qa-stack-test-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

// An explicit env, so a QA_*_PORT in the caller's shell cannot change a result.
const sh = (args: string[], env: Record<string, string>) => {
  const proc = Bun.spawnSync(['bash', stack, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RUNNER_TEMP: work, ...env },
    timeout: 4000,
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

/** Holds a port on `hostname` while `check` runs. Port 0 asks the OS for a free one. */
const withListener = (hostname: string, check: (port: number) => void) => {
  const listener = Bun.listen({ hostname, port: 0, socket: { data() {} } })
  try {
    check(listener.port)
  } finally {
    listener.stop(true)
  }
}

for (const hostname of ['127.0.0.1', '::1']) {
  test(`refuses a port held on ${hostname} and names its variable`, () => {
    withListener(hostname, (port) => {
      const { code, stdout, stderr } = sh(['serve', 'native'], { QA_BACKEND_PORT: String(port) })
      expect(code).toBe(1)
      expect(stderr).toContain(`port ${port} is in use: stop what listens there or set QA_BACKEND_PORT to a free port`)
      expect(stdout).not.toContain('stack ready')
    })
  })
}

test('refuses a value that is not a port', () => {
  const mcp = sh(['serve', 'native'], { QA_MCP_PORT: 'abc' })
  expect(mcp.code).toBe(2)
  expect(mcp.stderr).toContain("QA_MCP_PORT must be a port number from 1 to 65535, got 'abc'")
  const frontend = sh(['serve', 'native'], { QA_FRONTEND_PORT: '99999' })
  expect(frontend.code).toBe(2)
  expect(frontend.stderr).toContain("QA_FRONTEND_PORT must be a port number from 1 to 65535, got '99999'")
  // A leading zero would make the default backend port read as another stack's and rename its state files.
  const backend = sh(['serve', 'native'], { QA_BACKEND_PORT: '08005' })
  expect(backend.code).toBe(2)
  expect(backend.stderr).toContain("QA_BACKEND_PORT must be a port number from 1 to 65535, got '08005'")
})

/** A sleep that outlives this call and is nobody's child: `stop` waits on its pid with `kill -0`. */
const detachedSleep = () =>
  Number(Bun.spawnSync(['bash', '-c', 'sleep 30 > /dev/null 2>&1 & echo $!']).stdout.toString())
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Runs `stop` over two stacks' pid files, the default one and the one of backend port 2005. */
const stopWith = (env: Record<string, string>) => {
  const [defaultStack, otherStack] = [detachedSleep(), detachedSleep()]
  try {
    writeFileSync(join(work, 'qa-stack.pid'), String(defaultStack))
    writeFileSync(join(work, 'qa-stack-2005.pid'), String(otherStack))
    const { code } = sh(['stop'], env)
    return { code, defaultAlive: alive(defaultStack), otherAlive: alive(otherStack) }
  } finally {
    for (const pid of [defaultStack, otherStack]) if (alive(pid)) process.kill(pid)
  }
}

test('stop stops only the stack of its backend port', () => {
  expect(stopWith({ QA_BACKEND_PORT: '2005' })).toEqual({ code: 0, defaultAlive: true, otherAlive: false })
})

test('an empty variable means the default', () => {
  expect(stopWith({ QA_BACKEND_PORT: '' })).toEqual({ code: 0, defaultAlive: false, otherAlive: true })
})

test('stack URLs fall back to the defaults', () => {
  expect(stackURLs({})).toEqual({ frontend: 'http://localhost:1424', onboarding: 'http://localhost:1425' })
  expect(stackURLs({ QA_FRONTEND_PORT: '' }).frontend).toBe('http://localhost:1424')
  expect(stackURLs({ QA_FRONTEND_PORT: '2424', QA_ONBOARDING_PORT: '2425' })).toEqual({
    frontend: 'http://localhost:2424',
    onboarding: 'http://localhost:2425',
  })
})

test('the replay config takes its base URL from QA_FRONTEND_PORT', () => {
  const repoRoot = join(import.meta.dir, '../../..')
  const { stdout } = Bun.spawnSync(
    ['bun', '-e', "import c from './.github/qa/playwright.config.ts'; console.log(c.use?.baseURL)"],
    { cwd: repoRoot, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', QA_FRONTEND_PORT: '2424' } },
  )
  expect(stdout.toString()).toBe('http://localhost:2424\n')
})
