/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const bash = process.env.THUNDERDOCTOR_TEST_BASH ?? Bun.which('bash')
if (!bash) {
  throw new Error('thunderdoctor tests require Bash')
}

const systemEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key)),
)
const utilities = ['dirname', 'grep', 'head', 'sed', 'sort', 'uniq']
const resolved = Bun.spawnSync([bash, '-c', 'for tool in "$@"; do command -v "$tool" || exit 1; done', 'resolve-tools', ...utilities], {
  env: systemEnv,
})
if (resolved.exitCode !== 0) {
  throw new Error('thunderdoctor tests require standard Bash text utilities')
}
const utilityPaths = resolved.stdout.toString().trim().split(/\r?\n/)

/** Quotes a path for the isolated shell wrappers. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Converts Windows drive paths to Bash PATH entries, which use colons as separators. */
const shellPath = (value: string) => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)

/** Runs the real doctor against a synthetic project and an allowlist of tools. */
const runDoctor = async (nodeVersion: string | null, quiet = false, nodeExit = 0) => {
  const root = mkdtempSync(path.join(tmpdir(), 'thunderdoctor-'))
  const bin = path.join(root, 'bin')
  const home = path.join(root, 'home')
  const backend = path.join(root, 'backend')
  const script = path.join(root, 'scripts', 'thunderdoctor.sh')
  const frontendEnv = 'VITE_BACKEND_URL=http://127.0.0.1:1\n'
  const backendEnv = 'BETTER_AUTH_SECRET=synthetic-test-secret-000000000000000000\nDATABASE_DRIVER=sqlite\n'
  try {
    for (const dir of [bin, home, backend, path.dirname(script)]) {
      mkdirSync(dir, { recursive: true })
    }
    copyFileSync(path.join(import.meta.dir, 'thunderdoctor.sh'), script)
    writeFileSync(path.join(root, '.env'), frontendEnv)
    writeFileSync(path.join(backend, '.env'), backendEnv)
    writeFileSync(path.join(backend, '.env.example'), backendEnv)
    const writeTool = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    utilities.forEach((name, index) => writeTool(name, `exec ${shellQuote(utilityPaths[index])} "$@"`))
    for (const name of ['bun', 'cargo', 'cmake', 'sccache', 'docker', 'git', 'gh', 'linear', 'render', 'adb']) {
      writeTool(name, "printf '1.2.3\\n'")
    }
    writeTool('uname', "printf 'TestOS\\n'")
    if (nodeVersion !== null) {
      writeTool('node', `printf '%s\\n' ${shellQuote(nodeVersion)}; exit ${nodeExit}`)
    }
    // Bash receives a POSIX PATH even on Windows; no host tools or credentials leak into the fixture.
    const child = Bun.spawn([bash, script.replaceAll('\\', '/'), ...(quiet ? ['--quiet'] : [])], {
      cwd: root,
      env: {
        ...Object.fromEntries(Object.entries(systemEnv).filter(([key]) => key !== 'PATH')),
        PATH: shellPath(bin),
        HOME: home,
        USERPROFILE: home,
        THUNDERDOCTOR_AUTOFIX: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(frontendEnv)
    expect(readFileSync(path.join(backend, '.env'), 'utf8')).toBe(backendEnv)
    return { stdout, stderr, exitCode }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('thunderdoctor Node prerequisite', () => {
  it('is included in both default test commands', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const name of ['test', 'test:5x']) {
      expect(scripts[name]).toContain('scripts/thunderdoctor.test.ts')
    }
  })

  for (const version of [null, 'v16.17.0', 'v20.19.0', 'v22.18.0', 'invalid', 'v22.19.0-rc.1']) {
    it(`rejects ${version ?? 'missing Node'} as a critical failure`, async () => {
      const result = await runDoctor(version)
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('Node.js >=22.19.0')
      expect(result.stdout).toContain('PATH')
    })
  }

  for (const version of ['v22.19.0', 'v22.23.3', 'v24.0.0']) {
    it(`accepts ${version} when the other critical prerequisites pass`, async () => {
      const result = await runDoctor(version)
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(version)
      expect(result.stdout).not.toContain('Some critical tools are missing')
    })
  }

  it('rejects a failing node command even if it prints a supported version', async () => {
    expect((await runDoctor('v24.0.0', false, 1)).exitCode).toBe(1)
  })

  it('keeps the actionable error visible in quiet mode', async () => {
    const result = await runDoctor('v22.18.0', true)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('Node.js >=22.19.0')
    expect(result.stdout).toContain('v22.18.0')
    expect(result.stdout).toContain('PATH')
  })

  it('does not print a successful Node check in quiet mode', async () => {
    const result = await runDoctor('v24.0.0', true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('v24.0.0')
  })
})
