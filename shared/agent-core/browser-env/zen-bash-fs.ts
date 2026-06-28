/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `ZenBashFileSystem` is the bridge that lets just-bash run its 80+ coreutils
 * over the very same ZenFS mount that Pi's {@link BrowserExecutionEnv} reads and
 * writes. It implements just-bash's `IFileSystem` by forwarding every call to
 * the process-global ZenFS singleton (`@zenfs/core/promises`).
 *
 * This is half of the "OPFS-as-CLI" illusion: because both this adapter and the
 * execution env target one ZenFS instance, a file Pi writes is instantly
 * visible to `cat`, and a file a shell redirect creates is instantly readable
 * through Pi's filesystem API — no copying, no sync step.
 *
 * just-bash expects filesystem methods to THROW on failure (it catches and maps
 * them to shell exit codes internally), so this adapter deliberately forwards
 * ZenFS' Node-style errors unchanged rather than wrapping them.
 */

import * as fsp from '@zenfs/core/promises'
import { resolve } from '@zenfs/core/path'
import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from 'just-bash'
import type { ZenStats } from './fs-helpers.ts'

// just-bash declares these structurally in its `IFileSystem` module but does not
// re-export them from the package root; mirror them locally. Structural identity
// keeps `implements IFileSystem` satisfied.
type ReadFileOptions = { encoding?: BufferEncoding | null }
type WriteFileOptions = { encoding?: BufferEncoding }
type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

const encodingOf = (
  options: ReadFileOptions | WriteFileOptions | BufferEncoding | undefined,
): BufferEncoding | undefined => {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding ?? undefined
}

const toFsStat = (stat: ZenStats): FsStat => ({
  isFile: stat.isFile(),
  isDirectory: stat.isDirectory(),
  isSymbolicLink: stat.isSymbolicLink(),
  mode: stat.mode,
  size: stat.size,
  mtime: stat.mtime,
})

export class ZenBashFileSystem implements IFileSystem {
  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return await fsp.readFile(path, { encoding: encodingOf(options) ?? 'utf8' })
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(path))
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const encoding = encodingOf(options)
    await fsp.writeFile(path, content, encoding ? { encoding } : undefined)
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const encoding = encodingOf(options)
    await fsp.appendFile(path, content, encoding ? { encoding } : undefined)
  }

  async exists(path: string): Promise<boolean> {
    return await fsp.exists(path)
  }

  async stat(path: string): Promise<FsStat> {
    return toFsStat(await fsp.stat(path))
  }

  async lstat(path: string): Promise<FsStat> {
    return toFsStat(await fsp.lstat(path))
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await fsp.mkdir(path, { recursive: options?.recursive ?? false })
  }

  async readdir(path: string): Promise<string[]> {
    return await fsp.readdir(path)
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = await fsp.readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await fsp.rm(path, { recursive: options?.recursive ?? false, force: options?.force ?? false })
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await fsp.cp(src, dest, { recursive: options?.recursive ?? false })
  }

  async mv(src: string, dest: string): Promise<void> {
    await fsp.rename(src, dest)
  }

  resolvePath(base: string, path: string): string {
    return resolve(base, path)
  }

  getAllPaths(): string[] {
    return []
  }

  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(path, mode)
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await fsp.symlink(target, linkPath)
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await fsp.link(existingPath, newPath)
  }

  async readlink(path: string): Promise<string> {
    return await fsp.readlink(path)
  }

  async realpath(path: string): Promise<string> {
    return await fsp.realpath(path)
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await fsp.utimes(path, atime, mtime)
  }
}
