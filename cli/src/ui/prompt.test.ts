/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createTerminalIOFromStreams } from './prompt.ts'

test('preserves prompt whitespace while keeping secrets hidden', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ''
  output.on('data', (chunk: Buffer) => {
    rendered += chunk.toString()
  })
  const terminal = createTerminalIOFromStreams(input, output)

  try {
    const prompt = terminal.readLine('› ')
    input.write('  /exit  \n')
    await expect(prompt).resolves.toBe('  /exit  ')

    const secret = terminal.readSecret('API key: ')
    input.write('private-key\n')
    await expect(secret).resolves.toBe('private-key')
    expect(rendered).not.toContain('private-key')
    expect(rendered).not.toContain('\x1b')
  } finally {
    terminal.close()
  }
})

test('reads a line when stdin is a TTY', async () => {
  const input = new PassThrough()
  Object.defineProperty(input, 'isTTY', { value: true })
  const terminal = createTerminalIOFromStreams(input, new PassThrough())

  try {
    const prompt = terminal.readLine('› ')
    input.write('tty answer\r')
    await expect(prompt).resolves.toBe('tty answer')
  } finally {
    terminal.close()
  }
})

test('SIGINT aborts pending input and removes its scoped listener on close', async () => {
  const interrupts = new EventEmitter()
  const terminal = createTerminalIOFromStreams(new PassThrough(), new PassThrough(), { signalSource: interrupts })

  const pending = terminal.readLine('› ')
  interrupts.emit('SIGINT')

  await expect(pending).resolves.toBeNull()
  expect(terminal.signal.aborted).toBeTrue()
  expect(interrupts.listenerCount('SIGINT')).toBe(0)
  terminal.close()
  expect(interrupts.listenerCount('SIGINT')).toBe(0)
})

test('Ctrl-D ends input without cancelling non-interactive work', async () => {
  const input = new PassThrough()
  const interrupts = new EventEmitter()
  const terminal = createTerminalIOFromStreams(input, new PassThrough(), { signalSource: interrupts })

  const pending = terminal.readLine('› ')
  input.end()

  await expect(pending).resolves.toBeNull()
  expect(terminal.signal.aborted).toBeFalse()
  expect(interrupts.listenerCount('SIGINT')).toBe(1)
  terminal.close()
  expect(interrupts.listenerCount('SIGINT')).toBe(0)
})
