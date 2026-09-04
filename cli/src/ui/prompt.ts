/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import type { PermissionDecision, PermissionRequest } from '../agent/types.ts'

export type TerminalIO = {
  readonly readLine: (prompt: string) => Promise<string | null>
  readonly readSecret: (prompt: string) => Promise<string | null>
  readonly write: (text: string) => void
  readonly ask: (request: PermissionRequest) => Promise<PermissionDecision>
  readonly isTTY: boolean
  readonly signal: AbortSignal
  readonly close: () => void
}
type SignalSource = {
  readonly on: (event: 'SIGINT', listener: () => void) => void
  readonly off: (event: 'SIGINT', listener: () => void) => void
}

/** Creates shared prompt/manager I/O over explicit streams for production and tests. */
export const createTerminalIOFromStreams = (
  input: NodeJS.ReadableStream & { readonly isTTY?: boolean },
  output: NodeJS.WritableStream,
  options: { readonly signalSource?: SignalSource } = {},
): TerminalIO => {
  let muted = false
  const readlineOutput = new Writable({
    write: (chunk, _encoding, callback) => {
      if (!muted) output.write(chunk)
      callback()
    },
  })
  const rl = createInterface({ input, output: readlineOutput, terminal: Boolean(input.isTTY) })
  const cancellation = new AbortController()
  const inputClosed = new AbortController()
  const questionSignal = AbortSignal.any([cancellation.signal, inputClosed.signal])
  let closed = false
  const removeSigintListener = (): void => {
    options.signalSource?.off('SIGINT', onSigint)
  }
  const close = (): void => {
    if (closed) return
    closed = true
    cancellation.abort()
    rl.close()
    removeSigintListener()
  }
  const onSigint = (): void => close()
  options.signalSource?.on('SIGINT', onSigint)
  rl.on('close', () => inputClosed.abort())

  /** Reads one answer while suppressing terminal echo only for secrets. */
  const question = async (prompt: string, isSecret: boolean): Promise<string | null> => {
    if (isSecret) {
      output.write(prompt)
      muted = true
    }
    try {
      return await rl.question(isSecret ? '' : prompt, { signal: questionSignal })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return null
      throw error
    } finally {
      if (isSecret) {
        muted = false
        output.write('\n')
      }
    }
  }

  const readLine = (prompt: string): Promise<string | null> => question(prompt, false)
  const readSecret = (prompt: string): Promise<string | null> => question(prompt, true)
  const write = (text: string): void => {
    output.write(text)
  }
  const ask = async (request: PermissionRequest): Promise<PermissionDecision> => {
    const block = ['', `\x1b[33m⚠ allow ${request.toolName}?\x1b[0m`, `  ${request.summary}`]
    if (request.detail) block.push('', request.detail)
    write(`${block.join('\n')}\n`)

    const answer = (await readLine('Allow? [y]es / [a]lways / [N]o: '))?.trim().toLowerCase()
    if (answer === 'y' || answer === 'yes') return 'allow-once'
    if (answer === 'a' || answer === 'always') return 'allow-session'
    return 'deny'
  }

  return {
    isTTY: Boolean(input.isTTY),
    readLine,
    readSecret,
    write,
    ask,
    signal: cancellation.signal,
    close,
  }
}

/** Creates the production terminal I/O shared by onboarding, REPL, and permissions. */
export const createTerminalIO = (): TerminalIO =>
  createTerminalIOFromStreams(process.stdin, process.stdout, { signalSource: process })
