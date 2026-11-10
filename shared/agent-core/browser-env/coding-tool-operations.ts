/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Adapts the selected CodingEnvironment to the coding tools' throwing operation
 * contracts. Every file and shell operation uses that environment, so native
 * tools cannot accidentally read from or write to the OPFS singleton.
 */

import type { CodingEnvironment } from '../execution-environment.ts'
import type { Result, FileError } from '@earendil-works/pi-agent-core'

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
  readFile: (absolutePath: string, signal?: AbortSignal) => Promise<Buffer>
}

/** File-write backend for the write tool. */
export type WriteOperations = {
  writeFile: (absolutePath: string, content: string, signal?: AbortSignal) => Promise<void>
}

/** File read/write backend for the edit tool. */
export type EditOperations = ReadOperations & WriteOperations

/**
 * Build bash operations that run every command through the selected environment.
 * Streams stdout and stderr to the tool via `onData` and
 * surfaces the env's encoded failures by throwing them.
 *
 * @param env - the execution environment bound to the agent's cwd
 */
export const createBashOperations = (env: CodingEnvironment): BashOperations => ({
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

/** Decode the environment's Result at the throwing tool boundary. */
const unwrap = <T>(result: Result<T, FileError>): T => {
  if (!result.ok) {
    throw result.error
  }
  return result.value
}

/** Build file reads over the selected execution environment. */
export const createReadOperations = (env: CodingEnvironment): ReadOperations => ({
  readFile: async (path, signal) => Buffer.from(unwrap(await env.readBinaryFile(path, signal))),
})

/** Build file writes; the environment creates parent directories. */
export const createWriteOperations = (env: CodingEnvironment): WriteOperations => ({
  writeFile: async (path, content, signal) => {
    unwrap(await env.writeFile(path, content, signal))
  },
})

/** Build edits over the same environment as reads and shell commands. */
export const createEditOperations = (env: CodingEnvironment): EditOperations => ({
  ...createReadOperations(env),
  ...createWriteOperations(env),
})
