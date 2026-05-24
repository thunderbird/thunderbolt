/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { capStream } from './streaming'

const makeStream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })

const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    parts.push(value)
  }
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

describe('capStream', () => {
  it('forwards all bytes when under the cap', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const aborts: string[] = []
    const capped = capStream(makeStream([data]), {
      maxBytes: 100,
      idleTimeoutMs: 5000,
      onAbort: (r) => aborts.push(r),
    })
    const result = await collectStream(capped.stream)
    expect(result).toEqual(data)
    expect(aborts).toEqual([])
    expect(capped.bytesRead()).toBe(data.byteLength)
  })

  it('calls onAbort("cap") and terminates when bytes exceed cap', async () => {
    const chunk1 = new Uint8Array(6)
    const chunk2 = new Uint8Array(5)
    const aborts: string[] = []
    const capped = capStream(makeStream([chunk1, chunk2]), {
      maxBytes: 10,
      idleTimeoutMs: 5000,
      onAbort: (r) => aborts.push(r),
    })
    await collectStream(capped.stream)
    expect(aborts).toEqual(['cap'])
  })

  it('calls onAbort("idle") when no chunk arrives within idleTimeoutMs', async () => {
    const aborts: string[] = []
    const slow = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues — simulates idle upstream
      },
    })
    const capped = capStream(slow, {
      maxBytes: 1_000_000,
      idleTimeoutMs: 20,
      onAbort: (r) => aborts.push(r),
    })
    await collectStream(capped.stream)
    expect(aborts).toEqual(['idle'])
  })

  it('resets idle timer on each chunk so a slow-but-steady stream completes', async () => {
    const aborts: string[] = []
    const chunkDelay = 10
    const idleTimeout = 50

    // Produce 5 chunks with 10ms gaps — well within the 50ms idle timeout
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, chunkDelay))
          controller.enqueue(new Uint8Array([i]))
        }
        controller.close()
      },
    })

    const capped = capStream(slow, {
      maxBytes: 1_000_000,
      idleTimeoutMs: idleTimeout,
      onAbort: (r) => aborts.push(r),
    })
    const result = await collectStream(capped.stream)
    expect(result.byteLength).toBe(5)
    expect(aborts).toEqual([])
  })

  it('clears idle timer when cap fires so onAbort is not called twice', async () => {
    const aborts: string[] = []
    const idleTimeout = 30
    // Two chunks together exceed the cap; cap fires on the second chunk
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8))
        controller.enqueue(new Uint8Array(8))
        controller.close()
      },
    })
    const capped = capStream(stream, {
      maxBytes: 10,
      idleTimeoutMs: idleTimeout,
      onAbort: (r) => aborts.push(r),
    })
    await collectStream(capped.stream)
    // Wait longer than the idle timeout to confirm the lingering timer was cleared
    await new Promise((r) => setTimeout(r, idleTimeout * 2))
    expect(aborts).toEqual(['cap'])
  })

  it('does not fire onAbort after graceful stream end (flush clears idle timer)', async () => {
    const aborts: string[] = []
    const data = new Uint8Array([42])
    const capped = capStream(makeStream([data]), {
      maxBytes: 100,
      idleTimeoutMs: 20,
      onAbort: (r) => aborts.push(r),
    })
    await collectStream(capped.stream)
    // Wait longer than the idle timeout to confirm it was cleared
    await new Promise((r) => setTimeout(r, 40))
    expect(aborts).toEqual([])
  })

  it('clears idle timer on cancel so onAbort does not fire after downstream disconnects', async () => {
    const aborts: string[] = []
    const idleTimeout = 30
    // Stream that never enqueues — would idle out if not cancelled
    const slow = new ReadableStream<Uint8Array>({ start() {} })
    const capped = capStream(slow, {
      maxBytes: 1_000_000,
      idleTimeoutMs: idleTimeout,
      onAbort: (r) => aborts.push(r),
    })
    // Simulate client disconnect
    await capped.stream.cancel()
    // Wait longer than the idle timeout to confirm the timer was cleared
    await new Promise((r) => setTimeout(r, idleTimeout * 3))
    expect(aborts).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // Byte counter + onComplete contract — the observability layer reads these
  // ---------------------------------------------------------------------------

  it('bytesRead() returns the total bytes that flowed through on graceful completion', async () => {
    const chunks = [new Uint8Array(7), new Uint8Array(3), new Uint8Array(5)]
    const capped = capStream(makeStream(chunks), {
      maxBytes: 100,
      idleTimeoutMs: 1000,
      onAbort: () => {},
    })
    await collectStream(capped.stream)
    expect(capped.bytesRead()).toBe(15)
  })

  it('bytesRead() reports bytes consumed even when cap fires mid-stream', async () => {
    const chunks = [new Uint8Array(8), new Uint8Array(8)]
    const capped = capStream(makeStream(chunks), {
      maxBytes: 10,
      idleTimeoutMs: 1000,
      onAbort: () => {},
    })
    await collectStream(capped.stream)
    // First chunk (8B) passed, second pushed total over 10 — both have been
    // counted by the transform before terminate runs.
    expect(capped.bytesRead()).toBe(16)
  })

  it('onComplete fires once with the final byte count on graceful end', async () => {
    const completions: number[] = []
    const data = new Uint8Array([1, 2, 3])
    const capped = capStream(makeStream([data]), {
      maxBytes: 100,
      idleTimeoutMs: 1000,
      onAbort: () => {},
      onComplete: (n) => completions.push(n),
    })
    await collectStream(capped.stream)
    expect(completions).toEqual([3])
  })

  it('onComplete fires once with the abort byte count when cap triggers', async () => {
    const completions: number[] = []
    const chunks = [new Uint8Array(8), new Uint8Array(8)]
    const capped = capStream(makeStream(chunks), {
      maxBytes: 10,
      idleTimeoutMs: 1000,
      onAbort: () => {},
      onComplete: (n) => completions.push(n),
    })
    await collectStream(capped.stream)
    // onAbort runs before onComplete; onComplete must still see the bytes
    // counted up to the abort point and fire exactly once.
    expect(completions.length).toBe(1)
    expect(completions[0]).toBe(16)
  })

  it('onComplete fires once on idle timeout', async () => {
    const completions: number[] = []
    const slow = new ReadableStream<Uint8Array>({ start() {} })
    const capped = capStream(slow, {
      maxBytes: 1_000_000,
      idleTimeoutMs: 20,
      onAbort: () => {},
      onComplete: (n) => completions.push(n),
    })
    await collectStream(capped.stream)
    // Idle path fires onComplete from the timer + flush is never reached.
    expect(completions.length).toBe(1)
    expect(completions[0]).toBe(0)
  })

  it('onComplete fires once even after downstream cancel', async () => {
    const completions: number[] = []
    const slow = new ReadableStream<Uint8Array>({ start() {} })
    const capped = capStream(slow, {
      maxBytes: 1_000_000,
      idleTimeoutMs: 50,
      onAbort: () => {},
      onComplete: (n) => completions.push(n),
    })
    await capped.stream.cancel()
    // pipeTo rejects on cancel; the .catch() in capStream fires onComplete once.
    await new Promise((r) => setTimeout(r, 10))
    expect(completions.length).toBe(1)
    expect(completions[0]).toBe(0)
  })
})
