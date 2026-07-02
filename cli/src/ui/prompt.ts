/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createInterface } from 'node:readline/promises'
import type { PermissionDecision, PermissionRequest, TerminalIO } from '../agent/types.ts'

/**
 * Creates the interactive terminal I/O used by both the REPL input loop and the
 * permission gate. A single `node:readline/promises` interface backs every read
 * so the two never contend for stdin.
 *
 * @returns a {@link TerminalIO} bound to process stdin/stdout
 */
export const createTerminalIO = (): TerminalIO => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // readline emits 'close' when stdin ends (Ctrl-D / closed pipe). A pending
  // `question()` otherwise hangs forever, so abort it on close — that rejects
  // the read, which `readLine` turns into a `null` end-of-input signal.
  const eof = new AbortController()
  rl.on('close', () => eof.abort())

  const readLine = async (prompt: string): Promise<string | null> => {
    try {
      const answer = await rl.question(prompt, { signal: eof.signal })
      return answer.trim()
    } catch {
      return null
    }
  }

  const ask = async (request: PermissionRequest): Promise<PermissionDecision> => {
    const block = ['', `\x1b[33m⚠ allow ${request.toolName}?\x1b[0m`, `  ${request.summary}`]
    if (request.detail) block.push('', request.detail)
    process.stdout.write(`${block.join('\n')}\n`)

    const answer = (await readLine('Allow? [y]es / [a]lways / [N]o: '))?.toLowerCase()
    if (answer === 'y' || answer === 'yes') return 'allow-once'
    if (answer === 'a' || answer === 'always') return 'allow-session'
    return 'deny'
  }

  const close = (): void => {
    rl.close()
  }

  return { readLine, ask, close }
}
