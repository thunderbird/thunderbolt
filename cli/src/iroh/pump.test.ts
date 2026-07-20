/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests for the byte pumps. The load-bearing behaviors are the teardown
 * guarantees: `forwardToSend` MUST finish the stream on the error path too
 * (clean-FIN vs error-FIN), `forwardFromRecv` MUST stop on a zero-length read
 * and MUST apply backpressure (await the sink before the next read), and
 * `writeToStdin` MUST rethrow (and log) a flush failure rather than swallow it.
 * Streams/sinks are injected fakes — DI over mocking.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { FileSink } from 'bun'
import type { RecvStream, SendStream } from '@number0/iroh'
import { forwardFromRecv, forwardToSend, writeToStdin } from './pump.ts'

let stderr: ReturnType<typeof spyOn>
beforeEach(() => {
  stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  stderr.mockRestore()
})

/** A readable stream that yields the given chunks then ends. */
const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

describe('writeToStdin', () => {
  it('writes the chunk and awaits the flush on success', async () => {
    const calls: string[] = []
    const sink = {
      write: mock(() => {
        calls.push('write')
        return 1
      }),
      flush: mock(async () => {
        calls.push('flush')
        return 0
      }),
    } as unknown as FileSink
    const chunk = Uint8Array.from([1, 2, 3])
    await writeToStdin(sink, chunk, 'bridge')
    expect((sink.write as ReturnType<typeof mock>).mock.calls[0][0]).toBe(chunk)
    expect(calls).toEqual(['write', 'flush'])
  })

  it('logs loudly and rethrows when the flush fails (e.g. EPIPE on a dead pipe)', async () => {
    const boom = new Error('EPIPE')
    const sink = {
      write: mock(() => 1),
      flush: mock(async () => {
        throw boom
      }),
    } as unknown as FileSink
    await expect(writeToStdin(sink, Uint8Array.from([1]), 'connect')).rejects.toBe(boom)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0][0])).toContain('connect')
  })

  it('logs loudly and rethrows when the synchronous write itself throws', async () => {
    const boom = new Error('write blew up')
    const sink = {
      write: mock(() => {
        throw boom
      }),
      flush: mock(async () => 0),
    } as unknown as FileSink
    await expect(writeToStdin(sink, Uint8Array.from([1]), 'bridge')).rejects.toBe(boom)
    expect(sink.flush as ReturnType<typeof mock>).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledTimes(1)
  })
})

describe('forwardToSend', () => {
  it('writes each non-empty chunk verbatim and finishes once on clean EOF', async () => {
    const written: number[][] = []
    const send = {
      writeAll: mock(async (buf: number[]) => {
        written.push(buf)
      }),
      finish: mock(async () => {}),
    } as unknown as SendStream
    await forwardToSend(streamOf([Uint8Array.from([1, 2]), Uint8Array.from([3])]), send)
    expect(written).toEqual([[1, 2], [3]])
    expect(send.finish as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
  })

  it('skips zero-length chunks (never writes an empty frame)', async () => {
    const send = {
      writeAll: mock(async () => {}),
      finish: mock(async () => {}),
    } as unknown as SendStream
    await forwardToSend(streamOf([Uint8Array.from([]), Uint8Array.from([9])]), send)
    expect(send.writeAll as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
    expect((send.writeAll as ReturnType<typeof mock>).mock.calls[0][0]).toEqual([9])
  })

  it('still finishes the send half when the source errors mid-stream (error-FIN)', async () => {
    const boom = new Error('source exploded')
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw boom
      },
    })
    const send = {
      writeAll: mock(async () => {}),
      finish: mock(async () => {}),
    } as unknown as SendStream
    await expect(forwardToSend(source, send)).rejects.toBe(boom)
    expect(send.finish as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
  })

  it('still finishes the send half when writeAll itself rejects (error-FIN on the write path)', async () => {
    const boom = new Error('stream reset')
    const send = {
      writeAll: mock(async () => {
        throw boom
      }),
      finish: mock(async () => {}),
    } as unknown as SendStream
    await expect(forwardToSend(streamOf([Uint8Array.from([1])]), send)).rejects.toBe(boom)
    expect(send.finish as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
  })
})

describe('forwardFromRecv', () => {
  it('copies chunks (as Uint8Array) until a zero-length read signals EOF', async () => {
    const queue = [[1, 2, 3], [4], []]
    const recv = {
      read: mock(async () => queue.shift() ?? []),
    } as unknown as RecvStream
    const received: Uint8Array[] = []
    await forwardFromRecv(recv, (chunk) => {
      received.push(chunk)
    })
    expect(received.map((c) => [...c])).toEqual([[1, 2, 3], [4]])
    // 3 reads: two data chunks + the terminating empty read.
    expect(recv.read as ReturnType<typeof mock>).toHaveBeenCalledTimes(3)
    // Each read is bounded by readChunkLimit (1 << 16).
    expect((recv.read as ReturnType<typeof mock>).mock.calls[0][0]).toBe(1 << 16)
  })

  it('propagates a sink rejection and stops reading (e.g. stdin EPIPE tears the pump down)', async () => {
    const boom = new Error('EPIPE')
    const recv = {
      read: mock(async () => [1, 2]),
    } as unknown as RecvStream
    await expect(
      forwardFromRecv(recv, () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    // The loop must not keep draining the recv stream after the sink failed.
    expect(recv.read as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
  })

  it('applies backpressure: does not read again until the sink settles', async () => {
    const queue = [[1], []]
    const recv = {
      read: mock(async () => queue.shift() ?? []),
    } as unknown as RecvStream
    let releaseSink: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseSink = resolve
    })
    let sinkCalls = 0
    const done = forwardFromRecv(recv, () => {
      sinkCalls += 1
      return gate
    })
    // Drain all microtasks (macrotask flush), then assert we're parked on the sink.
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(sinkCalls).toBe(1)
    expect(recv.read as ReturnType<typeof mock>).toHaveBeenCalledTimes(1)
    releaseSink()
    await done
    expect(recv.read as ReturnType<typeof mock>).toHaveBeenCalledTimes(2)
  })
})
