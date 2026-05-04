/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { capStream } from './streaming'

const makeStream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const collectStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
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
    const result = await collectStream(capped)
    expect(result).toEqual(data)
    expect(aborts).toEqual([])
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
    await collectStream(capped)
    expect(aborts).toEqual(['cap'])
  })

  it('reports bytesOut equal to bytes actually delivered downstream when cap fires', async () => {
    // Two-chunk scenario: chunk1 fits, chunk2 would push past the cap. The
    // second chunk must be discarded (not enqueued) AND must not be counted
    // in the bytesOut total — otherwise billing/quota/audit metrics
    // over-report by one chunk on every cap fire.
    const chunk1 = new Uint8Array(6)
    const chunk2 = new Uint8Array(5)
    const aborts: string[] = []
    const completions: Array<{ bytesOut: number; reason: string }> = []
    const maxBytes = 10
    const capped = capStream(makeStream([chunk1, chunk2]), {
      maxBytes,
      idleTimeoutMs: 5000,
      onAbort: (r) => aborts.push(r),
      onComplete: (bytesOut, reason) => completions.push({ bytesOut, reason }),
    })
    const downstream = await collectStream(capped)

    expect(aborts).toEqual(['cap'])
    expect(completions).toHaveLength(1)
    expect(completions[0].reason).toBe('cap')
    // bytesOut must never exceed the cap — that would imply we counted bytes
    // we discarded.
    expect(completions[0].bytesOut).toBeLessThanOrEqual(maxBytes)
    // bytesOut must equal what the downstream consumer actually received —
    // the metric is the single source of truth for proxy observability.
    expect(completions[0].bytesOut).toBe(downstream.byteLength)
    // In this specific scenario only chunk1 is enqueued before cap fires.
    expect(downstream.byteLength).toBe(chunk1.byteLength)
  })

  it('reports bytesOut === maxBytes when a single chunk exactly fills the cap', async () => {
    // Edge case: a chunk that exactly hits maxBytes must be enqueued (not
    // discarded). The cap should only fire when a chunk WOULD push us strictly
    // past the limit.
    const exact = new Uint8Array(10)
    const completions: Array<{ bytesOut: number; reason: string }> = []
    const aborts: string[] = []
    const capped = capStream(makeStream([exact]), {
      maxBytes: 10,
      idleTimeoutMs: 5000,
      onAbort: (r) => aborts.push(r),
      onComplete: (bytesOut, reason) => completions.push({ bytesOut, reason }),
    })
    const downstream = await collectStream(capped)

    expect(aborts).toEqual([])
    expect(completions).toHaveLength(1)
    expect(completions[0].reason).toBe('done')
    expect(completions[0].bytesOut).toBe(10)
    expect(downstream.byteLength).toBe(10)
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
    await collectStream(capped)
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
    const result = await collectStream(capped)
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
    await collectStream(capped)
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
    await collectStream(capped)
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
    await capped.cancel()
    // Wait longer than the idle timeout to confirm the timer was cleared
    await new Promise((r) => setTimeout(r, idleTimeout * 3))
    expect(aborts).toEqual([])
  })
})
