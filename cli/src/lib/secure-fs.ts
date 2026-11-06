/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Filesystem helpers for security-sensitive CLI state. Static state-root,
 * intermediate, and final symlinks are rejected. Final files are opened with
 * no-follow flags and all chmod/read/write operations use the opened descriptor.
 *
 * Portable Node/Bun APIs do not expose `openat`, so an adversarial same-user
 * process could replace a previously validated parent directory after its
 * descriptor closes and before a later path operation. That concurrent parent
 * swap is outside the accepted threat model; static intermediate/final links
 * and final swaps before or after open are covered here.
 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'
import { toError } from '@earendil-works/pi-agent-core'

const fileMode = 0o600
const dirMode = 0o700

const readFileFlags = constants.O_RDONLY | constants.O_NOFOLLOW
const readDirectoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const createTempFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const lockRetryMs = 10
const malformedLockStaleMs = 60_000

/** Reads path metadata without following the final path component. */
const lstatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await fsPromises.lstat(path)
  } catch (error) {
    const failure = toError(error)
    if ('code' in failure && failure.code === 'ENOENT') return null
    throw error
  }
}

/** Rejects a symlink or non-directory path component. */
const assertDirectory = (path: string, stats: Stats): void => {
  if (stats.isSymbolicLink()) throw new Error(`refusing secure filesystem operation through symlink directory: ${path}`)
  if (!stats.isDirectory()) throw new Error(`secure filesystem owner is not a directory: ${path}`)
}

/** Rejects a symlink or non-regular final file. */
const assertRegularFile = (path: string, stats: Stats): void => {
  if (stats.isSymbolicLink()) throw new Error(`refusing secure filesystem operation on symlink target: ${path}`)
  if (!stats.isFile()) throw new Error(`secure filesystem target is not a regular file: ${path}`)
}

/** Verifies that an opened descriptor still identifies the lstat-validated entry. */
const assertSameEntry = (path: string, expected: Stats, opened: Stats): void => {
  if (expected.dev !== opened.dev || expected.ino !== opened.ino) {
    throw new Error(`secure filesystem target changed before open: ${path}`)
  }
}

/** Rejects user-owned symlinks in existing lexical ancestors of a state root. */
const assertNoSymlinkAncestors = async (path: string): Promise<void> => {
  const absolutePath = resolve(path)
  const filesystemRoot = parse(absolutePath).root
  const components = relative(filesystemRoot, absolutePath).split(sep).filter(Boolean).slice(0, -1)
  let current = filesystemRoot

  for (const component of components) {
    current = join(current, component)
    const stats = await lstatOrNull(current)
    if (stats === null) return
    if (!stats.isSymbolicLink()) {
      assertDirectory(current, stats)
      continue
    }

    const currentUid = process.getuid?.()
    if (currentUid === undefined || stats.uid === currentUid) {
      throw new Error(`refusing secure filesystem operation through symlink directory: ${current}`)
    }
    assertDirectory(current, await fsPromises.stat(current))
  }
}

/** Opens, validates, and chmods one directory through its descriptor. */
const secureDirectoryHandle = async (path: string, expected: Stats): Promise<void> => {
  const handle = await fsPromises.open(path, readDirectoryFlags)
  try {
    const opened = await handle.stat()
    assertDirectory(path, opened)
    assertSameEntry(path, expected, opened)
    await handle.chmod(dirMode)
  } finally {
    await handle.close()
  }
}

/** Validates the target's owning directory, optionally creating it. */
const secureDirectoryPath = async (path: string, create: boolean): Promise<boolean> => {
  await assertNoSymlinkAncestors(path)
  const existing = await lstatOrNull(path)
  if (existing === null && !create) return false
  if (existing === null) await fsPromises.mkdir(path, { recursive: true, mode: dirMode })

  const created = await fsPromises.lstat(path)
  assertDirectory(path, created)
  await secureDirectoryHandle(path, created)
  return true
}

/** Opens one prevalidated regular file without following a replacement symlink. */
const openRegularFile = async (path: string, expected: Stats): Promise<FileHandle> => {
  const handle = await fsPromises.open(path, readFileFlags)
  try {
    const opened = await handle.stat()
    assertRegularFile(path, opened)
    assertSameEntry(path, expected, opened)
    await handle.chmod(fileMode)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Creates, writes, and chmods one exclusive no-follow temporary file. */
const writeExclusiveTempFile = async (path: string, contents: string): Promise<void> => {
  const handle = await fsPromises.open(path, createTempFlags, fileMode)
  try {
    const opened = await handle.stat()
    assertRegularFile(path, opened)
    await handle.writeFile(contents, 'utf8')
    await handle.chmod(fileMode)
  } finally {
    await handle.close()
  }
}

/** Returns whether a recorded lock owner no longer exists. */
const isProcessGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    const failure = toError(error)
    if ('code' in failure && failure.code === 'ESRCH') return true
    if ('code' in failure && failure.code === 'EPERM') return false
    throw error
  }
}

/** Reads a contended lock while treating a replaced regular entry as a retry. */
const readLockFileOrNull = async (path: string): Promise<string | null> => {
  const expected = await lstatOrNull(path)
  if (expected === null) return null
  assertRegularFile(path, expected)
  const handle = await (async (): Promise<FileHandle | null> => {
    try {
      return await fsPromises.open(path, readFileFlags)
    } catch (error) {
      const failure = toError(error)
      if ('code' in failure && failure.code === 'ENOENT') return null
      throw error
    }
  })()
  if (handle === null) return null
  try {
    const opened = await handle.stat()
    assertRegularFile(path, opened)
    if (expected.dev !== opened.dev || expected.ino !== opened.ino) return null
    await handle.chmod(fileMode)
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

/** Returns whether an abandoned or malformed lock file can be removed. */
const isStaleLock = async (path: string): Promise<boolean> => {
  const contents = await readLockFileOrNull(path)
  if (contents === null) return true
  const pid = Number(contents.trim())
  if (Number.isSafeInteger(pid) && pid > 0) return isProcessGone(pid)
  const stats = await lstatOrNull(path)
  return stats !== null && Date.now() - stats.mtimeMs >= malformedLockStaleMs
}

/** Creates one lock file and cleans it up if recording ownership fails. */
const createSecureFileLock = async (path: string): Promise<FileHandle> => {
  const handle = await fsPromises.open(path, createTempFlags, fileMode)
  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    return handle
  } catch (error) {
    await handle.close()
    await fsPromises.rm(path, { force: true })
    throw error
  }
}

/** Releases only the same lock entry identified by the retained descriptor. */
const releaseSecureFileLock = async (path: string, handle: FileHandle): Promise<void> => {
  const owned = await handle.stat()
  await handle.close()
  const current = await lstatOrNull(path)
  if (current !== null && current.dev === owned.dev && current.ino === owned.ino) await fsPromises.unlink(path)
}

/** Rechecks and removes one stale lock while holding its exclusive reclaimer lock. */
const reclaimStaleLock = async (path: string): Promise<void> => {
  const reclaimerPath = `${path}.reclaim`
  const reclaimer = await acquireSecureFileLock(reclaimerPath)
  try {
    if (!(await isStaleLock(path))) return
    try {
      await fsPromises.unlink(path)
    } catch (error) {
      const failure = toError(error)
      if (!('code' in failure) || failure.code !== 'ENOENT') throw error
    }
  } finally {
    await releaseSecureFileLock(reclaimerPath, reclaimer)
  }
}

/** Creates and retains one exclusive lock file descriptor. */
const acquireSecureFileLock = async (path: string): Promise<FileHandle> => {
  try {
    return await createSecureFileLock(path)
  } catch (error) {
    const failure = toError(error)
    if (!('code' in failure) || failure.code !== 'EEXIST') throw error
    if (await isStaleLock(path)) {
      await reclaimStaleLock(path)
      return acquireSecureFileLock(path)
    }
    await new Promise((resolve) => setTimeout(resolve, lockRetryMs))
    return acquireSecureFileLock(path)
  }
}

/** Runs a secure state-file transaction under an exclusive cross-process lock. */
export const withSecureFileLock = async <Value>(path: string, operation: () => Promise<Value>): Promise<Value> => {
  const lockPath = `${path}.lock`
  await secureDirectoryPath(dirname(lockPath), true)
  const handle = await acquireSecureFileLock(lockPath)
  try {
    return await operation()
  } finally {
    await releaseSecureFileLock(lockPath, handle)
  }
}

/** Reads a regular UTF-8 file through one pinned descriptor, returning null only when absent. */
export const readFileOrNull = async (path: string): Promise<string | null> => {
  if (!(await secureDirectoryPath(dirname(path), false))) return null

  const expected = await lstatOrNull(path)
  if (expected === null) return null
  assertRegularFile(path, expected)

  const handle = await openRegularFile(path, expected)
  try {
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

/**
 * Writes through an exclusive same-directory temporary file and atomically
 * renames it over the target entry. Rename replaces a raced symlink
 * entry rather than following it; an existing static symlink is rejected.
 */
export const writeSecureFile = async (path: string, contents: string): Promise<void> => {
  await secureDirectoryPath(dirname(path), true)

  const target = await lstatOrNull(path)
  if (target !== null) assertRegularFile(path, target)

  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeExclusiveTempFile(tempPath, contents)
    await fsPromises.rename(tempPath, path)
  } finally {
    await fsPromises.rm(tempPath, { force: true })
  }
}

/** Removes a regular sensitive file without following static intermediate or final symlinks. */
export const removeSecureFile = async (path: string): Promise<void> => {
  if (!(await secureDirectoryPath(dirname(path), false))) return

  const target = await lstatOrNull(path)
  if (target === null) return
  assertRegularFile(path, target)
  await fsPromises.unlink(path)
}
