/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * {@link BrowserExecutionEnv}-backed operations for the four browser coding tools
 * (bash/read/write/edit, see `../coding-tools`). They redirect each tool's I/O
 * onto the same process-global ZenFS mount the harness runs over, replacing the
 * Node shell + `node:fs` backend the CLI tools assume.
 *
 * The bash operation delegates to {@link BrowserExecutionEnv.exec} (just-bash
 * over ZenFS); the file operations call `@zenfs/core/promises` directly — the
 * very same singleton — so a file the shell writes is instantly visible to the
 * read tool and vice versa. All four therefore share one consistent mount.
 *
 * The env is never-throwing (it encodes failures in a `Result`); the bash tool,
 * by contrast, decodes failures from a thrown error (and detects timeouts via a
 * `timeout:<seconds>` message). The bash adapter re-throws the env's
 * `ExecutionError` — whose `.message` already carries that exact framing — so the
 * tool's error/timeout handling works unchanged. This is the architectural
 * boundary translation, not defensive wrapping.
 *
 * Runtime note: the read/edit operations and the bash output bridge construct
 * Node `Buffer`s (the operation contracts are typed in terms of `Buffer`). The
 * app entry must ensure a global `Buffer` polyfill exists in the browser (the
 * standard `buffer` package shim) before driving the harness.
 */

import * as fsp from '@zenfs/core/promises'
import type { BrowserExecutionEnv } from './browser-execution-env.ts'

/** Streamed-execution backend for the bash tool. Throws on failure (aborted /
 *  `timeout:<seconds>` / other), matching the tool's error-decoding contract. */
export type BashOperations = {
  exec: (
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ) => Promise<{ exitCode: number | null }>
}

/** File-read backend for the read tool. */
export type ReadOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>
  access: (absolutePath: string) => Promise<void>
}

/** File-write backend for the write tool. */
export type WriteOperations = {
  writeFile: (absolutePath: string, content: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}

/** File read/write backend for the edit tool. */
export type EditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>
  writeFile: (absolutePath: string, content: string) => Promise<void>
  access: (absolutePath: string) => Promise<void>
}

/**
 * Build bash operations that run every command through `env` (just-bash over the
 * shared ZenFS mount). Streams stdout and stderr to the tool via `onData` and
 * surfaces the env's encoded failures by throwing them.
 *
 * @param env - the browser execution environment bound to the agent's cwd
 */
export const createBashOperations = (env: BrowserExecutionEnv): BashOperations => ({
  exec: async (command, cwd, { onData, signal, timeout }) => {
    const result = await env.exec(command, {
      cwd,
      timeout,
      abortSignal: signal,
      onStdout: (chunk) => onData(Buffer.from(chunk)),
      onStderr: (chunk) => onData(Buffer.from(chunk)),
    })
    if (result.ok) {
      return { exitCode: result.value.exitCode }
    }
    // env.exec never throws; re-throw the typed ExecutionError so Pi's bash tool
    // decodes it (its `.message` already carries the `timeout:<seconds>` framing).
    throw result.error
  },
})

/** Build read operations over the shared ZenFS mount. */
export const createReadOperations = (): ReadOperations => ({
  readFile: async (absolutePath) => Buffer.from(await fsp.readFile(absolutePath)),
  access: async (absolutePath) => {
    await fsp.access(absolutePath)
  },
})

/** Build write operations over the shared ZenFS mount. */
export const createWriteOperations = (): WriteOperations => ({
  writeFile: async (absolutePath, content) => {
    await fsp.writeFile(absolutePath, content)
  },
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true })
  },
})

/** Build edit operations over the shared ZenFS mount. */
export const createEditOperations = (): EditOperations => ({
  readFile: async (absolutePath) => Buffer.from(await fsp.readFile(absolutePath)),
  writeFile: async (absolutePath, content) => {
    await fsp.writeFile(absolutePath, content)
  },
  access: async (absolutePath) => {
    await fsp.access(absolutePath)
  },
})
