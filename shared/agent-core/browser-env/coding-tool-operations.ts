/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pluggable {@link BrowserExecutionEnv}-backed operations for Pi's four coding
 * tools (bash/read/write/edit). The tools default to Pi's local Node shell and
 * `node:fs` backend, which don't exist in the browser; these adapters redirect
 * each tool onto the same process-global ZenFS mount the harness runs over.
 *
 * The bash operation delegates to {@link BrowserExecutionEnv.exec} (just-bash
 * over ZenFS); the file operations call `@zenfs/core/promises` directly — the
 * very same singleton — so a file the shell writes is instantly visible to the
 * read tool and vice versa. All four therefore share one consistent mount.
 *
 * The env is never-throwing (it encodes failures in a `Result`); Pi's bash tool,
 * by contrast, decodes failures from a thrown error (and detects timeouts via a
 * `timeout:<seconds>` message). The bash adapter re-throws the env's
 * `ExecutionError` — whose `.message` already carries that exact framing — so the
 * tool's existing error/timeout handling works unchanged. This is the
 * architectural boundary translation Pi's contract calls for, not defensive
 * wrapping.
 *
 * Runtime note: the read/edit operations and the bash output bridge construct
 * Node `Buffer`s (Pi's operation contracts are typed in terms of `Buffer`). The
 * app entry must ensure a global `Buffer` polyfill exists in the browser (the
 * standard `buffer` package shim) before driving the harness.
 */

import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from '@earendil-works/pi-coding-agent'
import * as fsp from '@zenfs/core/promises'
import type { BrowserExecutionEnv } from './browser-execution-env.ts'

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
