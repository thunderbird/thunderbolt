/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Interop helpers that translate ZenFS results and errors into the shapes Pi's
 * {@link FileSystem} contract expects. ZenFS throws Node-style `errno` errors
 * (`ENOENT`, `EACCES`, …); these helpers map them onto Pi's backend-independent
 * {@link FileError} codes so the {@link BrowserExecutionEnv} can stay strictly
 * Result-based and never leak a thrown error.
 */

import { err, FileError, ok, toError, type FileInfo, type FileKind, type Result } from '@earendil-works/pi-agent-core'
import { basename } from '@zenfs/core/path'

/**
 * Structural view of a ZenFS `Stats` object. Declared structurally (rather than
 * importing ZenFS' concrete type) so the helpers stay decoupled from ZenFS'
 * internal class while remaining fully typed.
 */
export type ZenStats = {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  mode: number
  size: number
  mtime: Date
  mtimeMs: number
}

const isErrnoError = (error: unknown): error is { code: string; message: string } =>
  error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'

/**
 * Normalize an unknown thrown value (typically a ZenFS `errno` error) into a
 * Pi {@link FileError} with a stable, backend-independent code.
 *
 * @param error - the thrown value to translate
 * @param path - the addressed path associated with the failure, when known
 * @returns a {@link FileError} carrying the mapped code and the original cause
 */
export const toFileError = (error: unknown, path?: string): FileError => {
  if (error instanceof FileError) return error
  const cause = toError(error)
  if (isErrnoError(error)) {
    switch (error.code) {
      case 'ABORT_ERR':
        return new FileError('aborted', error.message, path, cause)
      case 'ENOENT':
        return new FileError('not_found', error.message, path, cause)
      case 'EACCES':
      case 'EPERM':
        return new FileError('permission_denied', error.message, path, cause)
      case 'ENOTDIR':
        return new FileError('not_directory', error.message, path, cause)
      case 'EISDIR':
        return new FileError('is_directory', error.message, path, cause)
      case 'EINVAL':
        return new FileError('invalid', error.message, path, cause)
    }
  }
  return new FileError('unknown', cause.message, path, cause)
}

const fileKindFrom = (stat: ZenStats): FileKind | undefined => {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  return undefined
}

/**
 * Build a Pi {@link FileInfo} from an addressed path and its ZenFS stats,
 * without following symlinks. Returns an `invalid` {@link FileError} for
 * filesystem object kinds Pi does not model.
 *
 * @param path - the absolute addressed path the stats describe
 * @param stat - the ZenFS stats for that path
 */
export const fileInfoFrom = (path: string, stat: ZenStats): Result<FileInfo, FileError> => {
  const kind = fileKindFrom(stat)
  if (!kind) return err(new FileError('invalid', 'Unsupported file type', path))
  return ok({ name: basename(path) || path, path, kind, size: stat.size, mtimeMs: stat.mtimeMs })
}

/**
 * Short-circuit Result for an already-aborted operation, or `undefined` when the
 * signal is still live. Lets callers early-return before touching ZenFS.
 *
 * @param signal - the caller's abort signal, if any
 * @param path - the addressed path, threaded into the {@link FileError}
 */
export const abortedResult = (signal: AbortSignal | undefined, path: string): Result<never, FileError> | undefined =>
  signal?.aborted ? err(new FileError('aborted', 'aborted', path)) : undefined

/**
 * Split UTF-8 text into lines the way Node's `readline` would: tolerate both
 * CRLF and LF, and drop the single trailing empty element a final newline
 * produces (so `"a\nb\n"` yields `["a", "b"]`, matching the Node env).
 *
 * @param text - the file contents to split
 */
export const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
