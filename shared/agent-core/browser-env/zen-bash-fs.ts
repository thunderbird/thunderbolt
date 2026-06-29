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
 *
 * Isolation: every path-accepting method is jailed to the thread's workspace
 * ({@link jailRoot}) via {@link resolveInWorkspace}, so a shell command using an
 * absolute path (`cat /etc/passwd`) or a `..`/sibling path (`cat
 * /workspace/<otherThread>/secret`, `ls /workspace`) throws and just-bash maps it
 * to a non-zero exit — a thread's shell can only touch its own files.
 * `resolvePath` stays a pure resolve (NOT jailed) so just-bash's internal
 * ancestor walks — e.g. resolving `..` up to `/` while discovering `.gitignore` —
 * still compute correctly; the subsequent file access is what enforces the jail.
 */

import * as fsp from '@zenfs/core/promises'
import { dirname, resolve } from '@zenfs/core/path'
import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from 'just-bash'
import type { ZenStats } from './fs-helpers.ts'
import { isWithinWorkspace, resolveInWorkspace } from './workspace-jail.ts'

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
  /**
   * @param jailRoot - the thread's absolute workspace dir; every path this
   *   adapter touches is asserted to stay inside it (see file header).
   */
  constructor(private readonly jailRoot: string) {}

  /** Resolve `path` against the jail root and assert it stays in the workspace,
   *  throwing on escape so just-bash maps it to a non-zero exit. */
  private jailed(path: string): string {
    return resolveInWorkspace(this.jailRoot, path)
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return await fsp.readFile(this.jailed(path), { encoding: encodingOf(options) ?? 'utf8' })
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.jailed(path)))
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const encoding = encodingOf(options)
    await fsp.writeFile(this.jailed(path), content, encoding ? { encoding } : undefined)
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const encoding = encodingOf(options)
    await fsp.appendFile(this.jailed(path), content, encoding ? { encoding } : undefined)
  }

  async exists(path: string): Promise<boolean> {
    const resolved = resolve(this.jailRoot, path)
    // A path outside the jail simply "doesn't exist" for this thread, so `[ -e ]`
    // tests resolve to false rather than erroring on the jail throw.
    return isWithinWorkspace(this.jailRoot, resolved) ? await fsp.exists(resolved) : false
  }

  async stat(path: string): Promise<FsStat> {
    return toFsStat(await fsp.stat(this.jailed(path)))
  }

  async lstat(path: string): Promise<FsStat> {
    return toFsStat(await fsp.lstat(this.jailed(path)))
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await fsp.mkdir(this.jailed(path), { recursive: options?.recursive ?? false })
  }

  async readdir(path: string): Promise<string[]> {
    return await fsp.readdir(this.jailed(path))
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = await fsp.readdir(this.jailed(path), { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await fsp.rm(this.jailed(path), { recursive: options?.recursive ?? false, force: options?.force ?? false })
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await fsp.cp(this.jailed(src), this.jailed(dest), { recursive: options?.recursive ?? false })
  }

  async mv(src: string, dest: string): Promise<void> {
    await fsp.rename(this.jailed(src), this.jailed(dest))
  }

  resolvePath(base: string, path: string): string {
    return resolve(base, path)
  }

  getAllPaths(): string[] {
    return []
  }

  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(this.jailed(path), mode)
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const resolvedLink = this.jailed(linkPath)
    // The target must also stay inside the workspace: ZenFS follows links when
    // reading, so an escaping target would leak through an in-jail link.
    resolveInWorkspace(this.jailRoot, resolve(dirname(resolvedLink), target))
    await fsp.symlink(target, resolvedLink)
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await fsp.link(this.jailed(existingPath), this.jailed(newPath))
  }

  async readlink(path: string): Promise<string> {
    return await fsp.readlink(this.jailed(path))
  }

  async realpath(path: string): Promise<string> {
    return await fsp.realpath(this.jailed(path))
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await fsp.utimes(this.jailed(path), atime, mtime)
  }
}
