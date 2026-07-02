/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser shim for Node's `fs/promises` / `node:fs/promises`, aliased in
 * `vite.config.ts` for the in-browser Pi harness path.
 *
 * The harness performs its real file I/O through the ZenFS-backed operation
 * adapters (see `coding-tool-operations.ts`), so Pi's own `fs/promises` calls are
 * inert on this path. This presents an empty filesystem: reads reject with
 * `ENOENT`, writes resolve as no-ops. It exists so importing Pi doesn't pull in
 * Vite's `browser-external` placeholder (whose members throw on access).
 */

/** Build a Node-style ENOENT error so Pi's error handling reads it as "missing". */
const enoent = (path: string): Error & { code: string } => {
  const error = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string }
  error.code = 'ENOENT'
  return error
}

export const access = (path: string): Promise<void> => Promise.reject(enoent(path))
export const readFile = (path: string): Promise<never> => Promise.reject(enoent(path))
export const stat = (path: string): Promise<never> => Promise.reject(enoent(path))
export const lstat = (path: string): Promise<never> => Promise.reject(enoent(path))
export const readlink = (path: string): Promise<never> => Promise.reject(enoent(path))
export const realpath = (path: string): Promise<string> => Promise.resolve(path)
export const readdir = (): Promise<string[]> => Promise.resolve([])
export const writeFile = (): Promise<void> => Promise.resolve()
export const appendFile = (): Promise<void> => Promise.resolve()
export const mkdir = (): Promise<undefined> => Promise.resolve(undefined)
export const mkdtemp = (prefix: string): Promise<string> => Promise.resolve(`${prefix}browser`)
export const rm = (): Promise<void> => Promise.resolve()
export const unlink = (): Promise<void> => Promise.resolve()
export const open = (path: string): Promise<never> => Promise.reject(enoent(path))

export default {
  access,
  readFile,
  stat,
  lstat,
  readlink,
  realpath,
  readdir,
  writeFile,
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  open,
}
