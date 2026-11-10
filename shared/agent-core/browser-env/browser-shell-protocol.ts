/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The worker can request only jailed filesystem operations, never arbitrary host methods. */
export const shellFileMethods = [
  'readFile',
  'readFileBuffer',
  'writeFile',
  'appendFile',
  'exists',
  'stat',
  'lstat',
  'mkdir',
  'readdir',
  'readdirWithFileTypes',
  'rm',
  'cp',
  'mv',
  'chmod',
  'symlink',
  'link',
  'readlink',
  'realpath',
  'utimes',
] as const

export type ShellFileMethod = (typeof shellFileMethods)[number]
export type ShellOutput = { stdout: string; stderr: string; exitCode: number }
export type ShellError = { name: string; message: string; code?: string }
export type ShellFileRequest = { type: 'fs'; id: number; method: ShellFileMethod; args: unknown[] }
export type ShellWorkerMessage =
  | ShellFileRequest
  | { type: 'result'; result: ShellOutput }
  | { type: 'error'; error: ShellError }
export type ShellHostMessage =
  | { type: 'start'; command: string; cwd: string; env: Record<string, string> }
  | { type: 'fs-result'; id: number; ok: true; value: unknown }
  | { type: 'fs-result'; id: number; ok: false; error: ShellError }

/** Preserve filesystem error codes across structured cloning so shell commands retain normal semantics. */
export const serializeShellError = (error: unknown): ShellError => ({
  name: error instanceof Error ? error.name : 'Error',
  message: error instanceof Error ? error.message : String(error),
  ...(typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? { code: error.code }
    : {}),
})

/** Recreate a remote error without depending on cross-realm Error prototypes. */
export const restoreShellError = (error: ShellError): Error =>
  Object.assign(new Error(error.message), { name: error.name, ...(error.code ? { code: error.code } : {}) })
