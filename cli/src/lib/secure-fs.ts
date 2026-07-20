/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Filesystem helpers for security-sensitive CLI state: the iroh identity (the
 * node's private key), the iroh allowlist (the authorization gate), and the
 * saved provider config (which can hold an API key).
 *
 * Such files are always written and re-`chmod`ed to owner-only (`0600` files
 * inside a `0700` dir). Enforcing the mode on every read/write means a key
 * restored from a lax backup or synced with loose permissions self-heals on
 * next use rather than silently staying exposed.
 *
 * A not-yet-created file is an expected first-run condition, not a failure — so
 * it maps to `null`; any other read error surfaces loudly.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'

/** Owner-only file mode for the secret/allowlist files. */
const fileMode = 0o600
/** Owner-only directory mode for the iroh state dir. */
const dirMode = 0o700

/**
 * Read a UTF-8 file, returning `null` only when it does not exist. All other
 * errors propagate so genuine problems aren't masked as a missing file.
 *
 * @param path - absolute path to read
 */
export const readFileOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Create (if needed) and lock down a directory to owner-only (`0700`). */
export const ensureSecureDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: dirMode })
  await chmod(dir, dirMode)
}

/** Force a file to owner-only (`0600`). Idempotent; safe to call on every load. */
export const enforceSecureFile = async (path: string): Promise<void> => {
  await chmod(path, fileMode)
}

/**
 * Write a security-sensitive file owner-only: ensure the parent dir is `0700`,
 * write `0600`, then re-`chmod` to defeat a permissive umask.
 *
 * @param dir - the owning directory (created + locked down if absent)
 * @param path - absolute file path within `dir`
 * @param contents - the bytes/text to write
 */
export const writeSecureFile = async (dir: string, path: string, contents: string): Promise<void> => {
  await ensureSecureDir(dir)
  await writeFile(path, contents, { mode: fileMode })
  await chmod(path, fileMode)
}
