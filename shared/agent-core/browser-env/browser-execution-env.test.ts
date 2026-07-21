/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `BrowserExecutionEnv` jail tests. The shell path (`exec`) already enforces the
 * workspace jail; these lock the *filesystem* surface (read/write/list/…) to the
 * same boundary, so a Pi tool can't reach a sibling thread's files via an
 * absolute or `..` path — and so a future method added without `jailed()` is
 * caught here rather than in production.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import { BrowserExecutionEnv } from './browser-execution-env.ts'
import { mountInMemoryFs } from './mount.ts'

const JAIL = '/workspace/t1'

beforeAll(async () => {
  await mountInMemoryFs()
  await fsp.mkdir('/workspace/t1', { recursive: true })
  await fsp.mkdir('/workspace/t2', { recursive: true })
  await fsp.writeFile('/workspace/t1/mine.txt', 'mine')
  await fsp.writeFile('/workspace/t2/secret.txt', 'secret')
  await fsp.mkdir('/etc', { recursive: true })
  await fsp.writeFile('/etc/passwd', 'root')
})

const env = new BrowserExecutionEnv({ cwd: JAIL })

describe('BrowserExecutionEnv filesystem jail', () => {
  it('reads files inside the workspace (absolute and relative)', async () => {
    const abs = await env.readTextFile('/workspace/t1/mine.txt')
    const rel = await env.readTextFile('mine.txt')
    expect(abs.ok && abs.value).toBe('mine')
    expect(rel.ok && rel.value).toBe('mine')
  })

  it('blocks reading a sibling thread workspace without leaking content', async () => {
    const result = await env.readTextFile('/workspace/t2/secret.txt')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('permission_denied')
  })

  it('blocks reading an absolute system path', async () => {
    const result = await env.readTextFile('/etc/passwd')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('permission_denied')
  })

  it('blocks `..` traversal into a sibling', async () => {
    const result = await env.readTextFile('../t2/secret.txt')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('permission_denied')
  })

  it('blocks readBinaryFile and readTextLines outside the jail', async () => {
    const bin = await env.readBinaryFile('/workspace/t2/secret.txt')
    const lines = await env.readTextLines('/etc/passwd')
    expect(bin.ok).toBe(false)
    expect(lines.ok).toBe(false)
  })

  it('blocks writing outside the workspace and does not create the file', async () => {
    const result = await env.writeFile('/workspace/t2/pwned.txt', 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('permission_denied')
    expect(await fsp.exists('/workspace/t2/pwned.txt')).toBe(false)
  })

  it('blocks appendFile outside the workspace', async () => {
    const result = await env.appendFile('/workspace/t2/secret.txt', 'x')
    expect(result.ok).toBe(false)
    expect(await fsp.readFile('/workspace/t2/secret.txt', { encoding: 'utf8' })).toBe('secret')
  })

  it('blocks removing outside the workspace and leaves the file intact', async () => {
    const result = await env.remove('/workspace/t2/secret.txt')
    expect(result.ok).toBe(false)
    expect(await fsp.exists('/workspace/t2/secret.txt')).toBe(true)
  })

  it('blocks listing the parent workspace root', async () => {
    const result = await env.listDir('/workspace')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('permission_denied')
  })

  it('blocks fileInfo, canonicalPath and createDir outside the jail', async () => {
    const info = await env.fileInfo('/workspace/t2/secret.txt')
    const canon = await env.canonicalPath('/etc/passwd')
    const dir = await env.createDir('/workspace/t2/sub')
    expect(info.ok).toBe(false)
    expect(canon.ok).toBe(false)
    expect(dir.ok).toBe(false)
    expect(await fsp.exists('/workspace/t2/sub')).toBe(false)
  })

  it('reports exists() as a permission error for out-of-jail paths (no existence oracle)', async () => {
    const escape = await env.exists('/etc/passwd')
    expect(escape.ok).toBe(false)
    if (!escape.ok) expect(escape.error.code).toBe('permission_denied')

    const insideMissing = await env.exists('nope.txt')
    expect(insideMissing.ok && insideMissing.value).toBe(false)
    const insidePresent = await env.exists('mine.txt')
    expect(insidePresent.ok && insidePresent.value).toBe(true)
  })

  it('writes and reads back a legitimate in-jail file', async () => {
    const write = await env.writeFile('nested/note.txt', 'hello')
    expect(write.ok).toBe(true)
    const read = await env.readTextFile('nested/note.txt')
    expect(read.ok && read.value).toBe('hello')
  })

  it('canonicalPath resolves an in-jail file (re-jail does not block legit paths)', async () => {
    const result = await env.canonicalPath('mine.txt')
    expect(result.ok && result.value).toBe('/workspace/t1/mine.txt')
  })

  it('keeps absolutePath pure (un-jailed) so ancestor computation still works', async () => {
    // Pure path math grants no access; the FS methods above are the gate.
    const result = await env.absolutePath('../t2/secret.txt')
    expect(result.ok && result.value).toBe('/workspace/t2/secret.txt')
  })

  it('blocks a shell whose cwd escapes the workspace', async () => {
    const result = await env.exec('echo hi', { cwd: '../t2' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('cwd escapes workspace')
  })

  it('emits output produced before a command times out', async () => {
    const timeoutEnv = new BrowserExecutionEnv({
      cwd: JAIL,
      createBash: () => ({
        exec: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { stdout: 'partial\n', stderr: 'warning\n', exitCode: 124, env: {} }
        },
      }),
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const result = await timeoutEnv.exec('ignored', {
      timeout: 0.001,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('timeout')
    expect(stdout.join('')).toBe('partial\n')
    expect(stderr.join('')).toBe('warning\n')
  })
})
