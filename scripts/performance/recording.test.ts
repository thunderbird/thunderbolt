/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CDPSession } from 'playwright'
import { expect, mock, test } from 'bun:test'
import { getClock } from '../../src/testing-library'
import { finishTrace } from './recording'

test('streams exact trace bytes and closes CDP handles, including when the output cannot be opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-trace-test-'))
  const bytes = Buffer.from('{"label":"é"}')
  const split = bytes.indexOf(Buffer.from('é')) + 1
  const chunks = [bytes.subarray(0, split), bytes.subarray(split)]
  const events = new EventEmitter()
  const send = mock(async (method: string) => {
    if (method === 'Tracing.end') {
      events.emit('Tracing.tracingComplete', { stream: 'trace' })
    }
    if (method === 'IO.read') {
      const data = chunks.shift()!
      return { data: data.toString('base64'), base64Encoded: true, eof: chunks.length === 0 }
    }
    return {}
  })
  const cdp = Object.assign(events, { send }) as unknown as CDPSession
  try {
    const path = join(directory, 'trace.json')
    await finishTrace(cdp, path)
    expect(await readFile(path)).toEqual(bytes)
    expect(send).toHaveBeenCalledWith('IO.close', { handle: 'trace' })
    expect(events.listenerCount('Tracing.tracingComplete')).toBe(0)
    send.mockClear()
    await expect(finishTrace(cdp, join(directory, 'missing', 'trace.json'))).rejects.toThrow()
    expect(send).toHaveBeenCalledWith('IO.close', { handle: 'trace' })
    expect(events.listenerCount('Tracing.tracingComplete')).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing trace completion has a bounded wait and detaches its listener', async () => {
  const events = new EventEmitter()
  const cdp = Object.assign(events, { send: async () => ({}) }) as unknown as CDPSession
  const finished = finishTrace(cdp, '/unused', 10)
  getClock().tick(10)
  await expect(finished).rejects.toThrow('capture timeout')
  expect(events.listenerCount('Tracing.tracingComplete')).toBe(0)
})

test('a simultaneous read and close failure preserves the primary trace error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thunderbolt-trace-failure-'))
  const original = new Error('trace read failed')
  const events = new EventEmitter()
  const send = mock(async (method: string) => {
    if (method === 'Tracing.end') {
      events.emit('Tracing.tracingComplete', { stream: 'trace' })
    }
    if (method === 'IO.read') {
      throw original
    }
    if (method === 'IO.close') {
      throw new Error('trace close failed')
    }
    return {}
  })
  try {
    await expect(
      finishTrace(Object.assign(events, { send }) as unknown as CDPSession, join(directory, 'trace.json')),
    ).rejects.toBe(original)
    expect(send).toHaveBeenCalledWith('IO.close', { handle: 'trace' })
    expect(events.listenerCount('Tracing.tracingComplete')).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
