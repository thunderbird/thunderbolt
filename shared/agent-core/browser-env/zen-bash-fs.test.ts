/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `ZenBashFileSystem` jail tests — the shell's only I/O channel. They lock the
 * security boundary: every path-accepting method must reject access outside the
 * thread's workspace, so a future method added without the jail is caught here.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import * as fsp from '@zenfs/core/promises'
import { mountInMemoryFs } from './mount.ts'
import { ZenBashFileSystem } from './zen-bash-fs.ts'

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

const fs = new ZenBashFileSystem(JAIL)

describe('ZenBashFileSystem jail', () => {
  it('reads files inside the workspace (absolute and relative)', async () => {
    expect(await fs.readFile('/workspace/t1/mine.txt')).toBe('mine')
    expect(await fs.readFile('mine.txt')).toBe('mine')
  })

  it('blocks reading a sibling thread workspace', async () => {
    await expect(fs.readFile('/workspace/t2/secret.txt')).rejects.toThrow('path escapes workspace')
  })

  it('blocks reading an absolute system path', async () => {
    await expect(fs.readFile('/etc/passwd')).rejects.toThrow('path escapes workspace')
  })

  it('blocks `..` traversal into a sibling', async () => {
    await expect(fs.readFile('../t2/secret.txt')).rejects.toThrow('path escapes workspace')
  })

  it('blocks enumerating the parent workspace root', async () => {
    await expect(fs.readdir('/workspace')).rejects.toThrow('path escapes workspace')
    await expect(fs.readdirWithFileTypes('/workspace')).rejects.toThrow('path escapes workspace')
  })

  it('blocks stat outside the workspace', async () => {
    await expect(fs.stat('/workspace/t2/secret.txt')).rejects.toThrow('path escapes workspace')
  })

  it('blocks writing outside the workspace', async () => {
    await expect(fs.writeFile('/workspace/t2/pwned.txt', 'x')).rejects.toThrow('path escapes workspace')
  })

  it('blocks removing outside the workspace', async () => {
    await expect(fs.rm('/workspace/t2/secret.txt')).rejects.toThrow('path escapes workspace')
  })

  it('blocks copy/move that escape the workspace', async () => {
    await expect(fs.cp('mine.txt', '/workspace/t2/copy.txt')).rejects.toThrow('path escapes workspace')
    await expect(fs.mv('/workspace/t2/secret.txt', 'stolen.txt')).rejects.toThrow('path escapes workspace')
  })

  it('blocks creating a symlink whose target escapes', async () => {
    await expect(fs.symlink('/workspace/t2/secret.txt', '/workspace/t1/link')).rejects.toThrow('path escapes workspace')
  })

  it('exists() returns false for out-of-jail paths instead of throwing', async () => {
    expect(await fs.exists('/etc/passwd')).toBe(false)
    expect(await fs.exists('/workspace/t1/mine.txt')).toBe(true)
  })

  it('keeps resolvePath pure (un-jailed) so ancestor walks still compute', () => {
    expect(fs.resolvePath('/workspace/t1', '..')).toBe('/workspace')
  })
})
