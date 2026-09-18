/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the security-sensitive filesystem helpers. The whole point of these
 * helpers is the 0600/0700 permission invariant (the files are a private key and
 * an auth gate), so the assertions check the actual on-disk mode against a real
 * temp dir — not a mocked fs.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { constants } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toError } from '@earendil-works/pi-agent-core'
import { thunderboltHomeDir } from '../paths.ts'
import { readFileOrNull, withSecureFileLock, writeSecureFile } from './secure-fs.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The permission bits (`& 0o777`) of a path. */
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

/** Runs an async action and returns its surfaced Error without skipping follow-up filesystem assertions. */
const getRejectedError = async (action: () => Promise<void>): Promise<Error | null> => {
  try {
    await action()
    return null
  } catch (error) {
    return toError(error)
  }
}

describe('withSecureFileLock', () => {
  it('reclaims a lock whose recorded owner process no longer exists', async () => {
    const path = join(dir, 'credential')
    await writeFile(`${path}.lock`, '2147483647\n')

    expect(await withSecureFileLock(path, async () => 'acquired')).toBe('acquired')
    expect(await readdir(dir)).toEqual([])
  })

  it('never overlaps contenders that both observe the same stale lock', async () => {
    const path = join(dir, 'credential')
    const lockPath = `${path}.lock`
    await writeFile(lockPath, '2147483647\n')
    const bothStaleReads = Promise.withResolvers<void>()
    const firstEntered = Promise.withResolvers<void>()
    const contenderAdvanced = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const readOpens = { count: 0 }
    const mainUnlinks = { count: 0 }
    const active = { count: 0, max: 0 }
    const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW
    const realOpen = fsPromises.open
    const realUnlink = fsPromises.unlink
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode)
      if (String(candidate) !== lockPath || Number(flags) !== readFlags) return handle
      readOpens.count += 1
      if (readOpens.count === 2) bothStaleReads.resolve()
      if (readOpens.count <= 2) await bothStaleReads.promise
      else contenderAdvanced.resolve()
      return handle
    })
    const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async (candidate) => {
      if (String(candidate) !== lockPath) return realUnlink(candidate)
      const index = mainUnlinks.count
      mainUnlinks.count += 1
      if (index === 1) await firstEntered.promise
      return realUnlink(candidate)
    })
    const operation = async (): Promise<void> => {
      active.count += 1
      active.max = Math.max(active.max, active.count)
      if (active.count === 1) {
        firstEntered.resolve()
        await releaseFirst.promise
      } else {
        contenderAdvanced.resolve()
      }
      active.count -= 1
    }

    try {
      const contenders = [withSecureFileLock(path, operation), withSecureFileLock(path, operation)]
      await firstEntered.promise
      await contenderAdvanced.promise
      const maxActive = active.max
      releaseFirst.resolve()
      await Promise.all(contenders)

      expect(maxActive).toBe(1)
    } finally {
      releaseFirst.resolve()
      openSpy.mockRestore()
      unlinkSpy.mockRestore()
    }
  })
})

describe('readFileOrNull', () => {
  it('returns null for a non-existent file (expected first-run, not a failure)', async () => {
    expect(await readFileOrNull(join(dir, 'nope'))).toBeNull()
  })

  it('returns file contents and repairs owner-only permissions', async () => {
    const path = join(dir, 'f')
    await writeFile(path, 'hello')
    await chmod(dir, 0o755)
    await chmod(path, 0o644)

    expect(await readFileOrNull(path)).toBe('hello')
    expect(await modeOf(dir)).toBe(0o700)
    expect(await modeOf(path)).toBe(0o600)
  })

  it('rejects a symlink target without reading or changing its destination', async () => {
    const destination = join(dir, 'destination')
    const path = join(dir, 'link')
    await writeFile(destination, 'original')
    await symlink(destination, path)

    const error = await getRejectedError(async () => {
      await readFileOrNull(path)
    })
    const destinationContents = await readFile(destination, 'utf8')

    expect(error).toBeInstanceOf(Error)
    expect(destinationContents).toBe('original')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  it('rejects a final target swapped to a symlink between lstat and open', async () => {
    const path = join(dir, 'credential')
    const destination = join(dir, 'destination')
    await writeFile(path, 'original')
    await writeFile(destination, 'outside-original')
    const realOpen = fsPromises.open
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
      if (String(candidate) === path) {
        await rm(path)
        await symlink(destination, path)
      }
      return realOpen(candidate, flags, mode)
    })

    try {
      const error = await getRejectedError(async () => {
        await readFileOrNull(path)
      })

      expect(error).toBeInstanceOf(Error)
      expect(await readFile(destination, 'utf8')).toBe('outside-original')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('keeps reading the opened file descriptor when the path is swapped after open', async () => {
    const path = join(dir, 'credential')
    const destination = join(dir, 'destination')
    await writeFile(path, 'original')
    await writeFile(destination, 'outside-original')
    const realOpen = fsPromises.open
    let swapped = false
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode)
      if (String(candidate) === path) {
        await rm(path)
        await symlink(destination, path)
        swapped = true
      }
      return handle
    })

    try {
      expect(await readFileOrNull(path)).toBe('original')
      expect(swapped).toBe(true)
      expect(await readFile(destination, 'utf8')).toBe('outside-original')
    } finally {
      openSpy.mockRestore()
    }
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
    await writeSecureFile(path, 'secret')
    expect(await readFileOrNull(path)).toBe('secret')
    expect(await modeOf(path)).toBe(0o600)
    expect(await modeOf(sub)).toBe(0o700)
  })

  it('repairs an existing too-permissive parent dir down to 0700', async () => {
    const sub = join(dir, 'iroh')
    await mkdir(sub, { mode: 0o755 })
    await chmod(sub, 0o755)
    await writeSecureFile(join(sub, 'identity'), 'secret')
    expect(await modeOf(sub)).toBe(0o700)
  })

  it('re-chmods an existing too-permissive file back to 0600 (defeats a lax umask)', async () => {
    const path = join(dir, 'f')
    await writeFile(path, 'old', { mode: 0o644 })
    await chmod(path, 0o644)
    expect(await modeOf(path)).toBe(0o644)
    await writeSecureFile(path, 'new')
    expect(await modeOf(path)).toBe(0o600)
    expect(await readFileOrNull(path)).toBe('new')
  })

  it('rejects an owning-directory symlink before chmod or write', async () => {
    const destination = join(dir, 'destination')
    const linkedDir = join(dir, 'linked')
    const destinationFile = join(destination, 'sentinel')
    await mkdir(destination, { mode: 0o755 })
    await chmod(destination, 0o755)
    await writeFile(destinationFile, 'original')
    await symlink(destination, linkedDir)

    const error = await getRejectedError(() => writeSecureFile(join(linkedDir, 'secret'), 'new'))
    const destinationMode = await modeOf(destination)
    const destinationContents = await readFile(destinationFile, 'utf8')
    const destinationEntries = await readdir(destination)

    expect(error).toBeInstanceOf(Error)
    expect(destinationMode).toBe(0o755)
    expect(destinationContents).toBe('original')
    expect(destinationEntries).toEqual(['sentinel'])
  })

  it('rejects a THUNDERBOLT_HOME with a symlink in its lexical ancestry', async () => {
    const destination = join(dir, 'destination')
    const linkedAncestor = join(dir, 'linked-ancestor')
    const stateRoot = thunderboltHomeDir({ THUNDERBOLT_HOME: join(linkedAncestor, 'thunderbolt-home') })
    const destinationFile = join(destination, 'sentinel')
    await mkdir(destination, { mode: 0o755 })
    await chmod(destination, 0o755)
    await writeFile(destinationFile, 'outside-original')
    await symlink(destination, linkedAncestor)

    const error = await getRejectedError(() => writeSecureFile(join(stateRoot, 'credentials.json'), 'replacement'))

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('symlink')
    expect(await modeOf(destination)).toBe(0o755)
    expect(await readFile(destinationFile, 'utf8')).toBe('outside-original')
    expect(await readdir(destination)).toEqual(['sentinel'])
  })

  it('rejects a target symlink without replacing or changing its destination', async () => {
    const destination = join(dir, 'destination')
    const path = join(dir, 'link')
    await writeFile(destination, 'original')
    await symlink(destination, path)

    const error = await getRejectedError(() => writeSecureFile(path, 'replacement'))
    const destinationContents = await readFile(destination, 'utf8')

    expect(error).toBeInstanceOf(Error)
    expect(destinationContents).toBe('original')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  it('opens directories and temporary files with no-follow flags', async () => {
    const path = join(dir, 'credential')
    const realOpen = fsPromises.open
    let directoryFlags: number | null = null
    let tempFlags: number | null = null
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode)
      const numericFlags = Number(flags)
      if (String(candidate) === dir && Number.isInteger(numericFlags)) directoryFlags = numericFlags
      if (String(candidate).startsWith(join(dir, '.credential.')) && Number.isInteger(numericFlags)) {
        tempFlags = numericFlags
      }
      return handle
    })

    try {
      await writeSecureFile(path, 'replacement')

      expect(directoryFlags === null ? 0 : directoryFlags & constants.O_DIRECTORY).toBe(constants.O_DIRECTORY)
      expect(directoryFlags === null ? 0 : directoryFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
      expect(tempFlags === null ? 0 : tempFlags & constants.O_CREAT).toBe(constants.O_CREAT)
      expect(tempFlags === null ? 0 : tempFlags & constants.O_EXCL).toBe(constants.O_EXCL)
      expect(tempFlags === null ? 0 : tempFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('replaces a target swapped to a symlink before rename without following it', async () => {
    const path = join(dir, 'credential')
    const destination = join(dir, 'destination')
    await writeFile(path, 'original')
    await writeFile(destination, 'outside-original')
    const realOpen = fsPromises.open
    let swapped = false
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
      const handle = await realOpen(candidate, flags, mode)
      if (String(candidate).startsWith(join(dir, '.credential.'))) {
        await rm(path)
        await symlink(destination, path)
        swapped = true
      }
      return handle
    })

    try {
      await writeSecureFile(path, 'replacement')

      expect(swapped).toBe(true)
      expect((await lstat(path)).isSymbolicLink()).toBe(false)
      expect(await readFile(path, 'utf8')).toBe('replacement')
      expect(await readFile(destination, 'utf8')).toBe('outside-original')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('preserves the original bytes and removes the temporary file when atomic rename fails', async () => {
    const path = join(dir, 'credential')
    await writeFile(path, 'original', { mode: 0o600 })
    const rename = spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('interrupted rename'))

    try {
      const error = await getRejectedError(() => writeSecureFile(path, 'replacement'))
      const contents = await readFile(path, 'utf8')
      const entries = await readdir(dir)

      expect(error).toMatchObject({ message: 'interrupted rename' })
      expect(contents).toBe('original')
      expect(entries).toEqual(['credential'])
    } finally {
      rename.mockRestore()
    }
  })
})
