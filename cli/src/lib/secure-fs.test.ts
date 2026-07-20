/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the security-sensitive filesystem helpers. The whole point of these
 * helpers is the 0600/0700 permission invariant (the files are a private key and
 * an auth gate), so the assertions check the actual on-disk mode against a real
 * temp dir — not a mocked fs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enforceSecureFile, ensureSecureDir, readFileOrNull, writeSecureFile } from './secure-fs.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The permission bits (`& 0o777`) of a path. */
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('readFileOrNull', () => {
  it('returns null for a non-existent file (expected first-run, not a failure)', async () => {
    expect(await readFileOrNull(join(dir, 'nope'))).toBeNull()
  })

  it('returns the file contents when present', async () => {
    const path = join(dir, 'f')
    await writeFile(path, 'hello')
    expect(await readFileOrNull(path)).toBe('hello')
  })

  it('rethrows a non-ENOENT error rather than masking it as missing', async () => {
    // Reading a directory yields EISDIR, not ENOENT — must surface loudly.
    await expect(readFileOrNull(dir)).rejects.toThrow()
  })
})

describe('writeSecureFile', () => {
  it('creates the dir 0700 and the file 0600', async () => {
    const sub = join(dir, 'iroh')
    const path = join(sub, 'identity')
    await writeSecureFile(sub, path, 'secret')
    expect(await readFileOrNull(path)).toBe('secret')
    expect(await modeOf(path)).toBe(0o600)
    expect(await modeOf(sub)).toBe(0o700)
  })

  it('repairs an existing too-permissive parent dir down to 0700', async () => {
    const sub = join(dir, 'iroh')
    await mkdir(sub, { mode: 0o755 })
    await chmod(sub, 0o755)
    await writeSecureFile(sub, join(sub, 'identity'), 'secret')
    expect(await modeOf(sub)).toBe(0o700)
  })

  it('re-chmods an existing too-permissive file back to 0600 (defeats a lax umask)', async () => {
    const path = join(dir, 'f')
    await writeFile(path, 'old', { mode: 0o644 })
    await chmod(path, 0o644)
    expect(await modeOf(path)).toBe(0o644)
    await writeSecureFile(dir, path, 'new')
    expect(await modeOf(path)).toBe(0o600)
    expect(await readFileOrNull(path)).toBe('new')
  })
})

describe('ensureSecureDir', () => {
  it('forces an existing permissive dir down to 0700', async () => {
    const sub = join(dir, 'loose')
    await mkdir(sub, { mode: 0o755 })
    await chmod(sub, 0o755)
    await ensureSecureDir(sub)
    expect(await modeOf(sub)).toBe(0o700)
  })
})

describe('enforceSecureFile', () => {
  it('chmods a file to owner-only 0600', async () => {
    const path = join(dir, 'f')
    await writeFile(path, 'x', { mode: 0o666 })
    await chmod(path, 0o666)
    await enforceSecureFile(path)
    expect(await modeOf(path)).toBe(0o600)
  })
})
