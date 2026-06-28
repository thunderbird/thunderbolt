/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `BrowserExecutionEnv` is Pi's {@link ExecutionEnv} (filesystem + shell)
 * implemented entirely on top of a single ZenFS mount, with the shell provided
 * by just-bash. It is the in-browser analogue of Pi's `NodeExecutionEnv`: same
 * Result-based contract, same four-tool surface, but backed by ZenFS instead of
 * `node:fs` and by just-bash instead of a spawned `/bin/bash`.
 *
 * Both halves target the SAME ZenFS singleton:
 *   - filesystem methods call `@zenfs/core/promises` directly;
 *   - `exec()` runs commands through a fresh just-bash `Bash` bound to a
 *     {@link ZenBashFileSystem} adapter over that same singleton.
 * That shared mount is what makes a Pi `writeFile` instantly visible to `cat`,
 * and a shell redirect instantly readable via `readTextFile`.
 *
 * Every operation method honours Pi's invariant of never throwing: ZenFS' and
 * just-bash's thrown errors are caught at this adapter boundary and encoded into
 * the returned {@link Result}. This is the architectural error-handling layer
 * the contract mandates, not defensive wrapping of trusted calls.
 *
 * ZenFS is a process-global singleton; configure it once via `mountInMemoryFs()`
 * (or, in the app, a `@zenfs/dom` OPFS backend) before constructing this env.
 */

import {
  err,
  ExecutionError,
  ok,
  toError,
  type ExecutionEnv,
  type FileError,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from '@earendil-works/pi-agent-core'
import * as fsp from '@zenfs/core/promises'
import { dirname, join, resolve } from '@zenfs/core/path'
import { Bash } from 'just-bash'
import { abortedResult, fileInfoFrom, splitLines, toFileError } from './fs-helpers.ts'
import { ZenBashFileSystem } from './zen-bash-fs.ts'

/** Mount-relative root under which {@link BrowserExecutionEnv.createTempDir} carves unique directories. */
const TEMP_ROOT = '/tmp'

export class BrowserExecutionEnv implements ExecutionEnv {
  cwd: string
  private readonly env: Record<string, string>
  private readonly bashFs: ZenBashFileSystem

  constructor(options: { cwd: string; env?: Record<string, string> }) {
    this.cwd = options.cwd
    this.env = options.env ?? {}
    this.bashFs = new ZenBashFileSystem()
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(resolve(this.cwd, path))
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(join(...parts))
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options?.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'))

    const cwd = options?.cwd ? resolve(this.cwd, options.cwd) : this.cwd
    const env = { ...this.env, ...options?.env }
    const controller = new AbortController()
    const state = { timedOut: false }
    const onExternalAbort = () => controller.abort()
    if (options?.abortSignal) options.abortSignal.addEventListener('abort', onExternalAbort, { once: true })
    const timeoutId =
      typeof options?.timeout === 'number'
        ? setTimeout(() => {
            state.timedOut = true
            controller.abort()
          }, options.timeout * 1000)
        : undefined

    try {
      // `defenseInDepth` (default ON) monkey-patches/blocks JS globals (Proxy,
      // eval, Function, …) to contain escapes from just-bash's *sandboxed JS*
      // surfaces — `js-exec` (QuickJS) and python. We enable neither, so it
      // guards nothing here while actively breaking the bash interpreter (it
      // trips on just-bash's own internal `Proxy` use). The real sandbox is the
      // virtual ZenFS mount with no host-process access, so we disable it.
      const bash = new Bash({ fs: this.bashFs, cwd, env, defenseInDepth: false })
      const result = await bash.exec(command, { signal: controller.signal })
      if (state.timedOut) return err(new ExecutionError('timeout', `timeout:${options?.timeout}`))
      if (options?.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'))
      if (result.stdout) options?.onStdout?.(result.stdout)
      if (result.stderr) options?.onStderr?.(result.stderr)
      return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode })
    } catch (error) {
      if (state.timedOut) return err(new ExecutionError('timeout', `timeout:${options?.timeout}`))
      if (controller.signal.aborted) return err(new ExecutionError('aborted', 'aborted'))
      const cause = toError(error)
      return err(new ExecutionError('unknown', cause.message, cause))
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      if (options?.abortSignal) options.abortSignal.removeEventListener('abort', onExternalAbort)
    }
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const resolved = resolve(this.cwd, path)
    const aborted = abortedResult(abortSignal, resolved)
    if (aborted) return aborted
    try {
      return ok(await fsp.readFile(resolved, { encoding: 'utf8' }))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    const resolved = resolve(this.cwd, path)
    const aborted = abortedResult(options?.abortSignal, resolved)
    if (aborted) return aborted
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([])
    try {
      const lines = splitLines(await fsp.readFile(resolved, { encoding: 'utf8' }))
      return ok(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const resolved = resolve(this.cwd, path)
    const aborted = abortedResult(abortSignal, resolved)
    if (aborted) return aborted
    try {
      return ok(new Uint8Array(await fsp.readFile(resolved)))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const resolved = resolve(this.cwd, path)
    const aborted = abortedResult(abortSignal, resolved)
    if (aborted) return aborted
    try {
      await fsp.mkdir(dirname(resolved), { recursive: true })
      const afterMkdir = abortedResult(abortSignal, resolved)
      if (afterMkdir) return afterMkdir
      await fsp.writeFile(resolved, content)
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const resolved = resolve(this.cwd, path)
    try {
      await fsp.mkdir(dirname(resolved), { recursive: true })
      await fsp.appendFile(resolved, content)
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const resolved = resolve(this.cwd, path)
    try {
      return fileInfoFrom(resolved, await fsp.lstat(resolved))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const resolved = resolve(this.cwd, path)
    const aborted = abortedResult(abortSignal, resolved)
    if (aborted) return aborted
    try {
      const entries = await fsp.readdir(resolved, { withFileTypes: true })
      const infos: FileInfo[] = []
      for (const entry of entries) {
        const loopAborted = abortedResult(abortSignal, resolved)
        if (loopAborted) return loopAborted
        const childPath = join(resolved, entry.name)
        const info = fileInfoFrom(childPath, await fsp.lstat(childPath))
        if (info.ok) infos.push(info.value)
      }
      return ok(infos)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    const resolved = resolve(this.cwd, path)
    try {
      return ok(await fsp.realpath(resolved))
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path)
    if (result.ok) return ok(true)
    if (result.error.code === 'not_found') return ok(false)
    return err(result.error)
  }

  async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
    const resolved = resolve(this.cwd, path)
    try {
      await fsp.mkdir(resolved, { recursive: options?.recursive ?? true })
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
    const resolved = resolve(this.cwd, path)
    try {
      await fsp.rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false })
      return ok(undefined)
    } catch (error) {
      return err(toFileError(error, resolved))
    }
  }

  async createTempDir(prefix = 'tmp-'): Promise<Result<string, FileError>> {
    try {
      // `crypto.randomUUID()` is generated inside the try: outside a secure
      // context the browser leaves it undefined, so calling it throws — which
      // would break the never-throw contract if it ran before the try.
      const dir = join(TEMP_ROOT, `${prefix}${crypto.randomUUID()}`)
      await fsp.mkdir(TEMP_ROOT, { recursive: true })
      await fsp.mkdir(dir)
      return ok(dir)
    } catch (error) {
      return err(toFileError(error, TEMP_ROOT))
    }
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir('tmp-')
    if (!dir.ok) return dir
    try {
      const filePath = join(dir.value, `${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`)
      await fsp.writeFile(filePath, '')
      return ok(filePath)
    } catch (error) {
      return err(toFileError(error, dir.value))
    }
  }

  async cleanup(): Promise<void> {
    // ZenFS is a shared, process-global singleton owned by the mount; there is
    // nothing per-env to release. Kept as a no-op to satisfy the contract.
  }
}
