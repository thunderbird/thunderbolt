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
