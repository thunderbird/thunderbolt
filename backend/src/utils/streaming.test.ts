/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, jest } from 'bun:test'
import { createSSEStreamFromCompletion, type CompletionUsageSnapshot } from './streaming'

type Completion = Parameters<typeof createSSEStreamFromCompletion>[0]
type CompletionChunk = Completion extends AsyncIterable<infer Chunk> ? Chunk : never
type TestCompletionUsage = {
  prompt_tokens?: number | string | null
  completion_tokens?: number | string | null
  total_tokens?: number | string | null
}
type TestCompletionChunk = {
  id: string
  choices?: readonly { delta?: { content?: string } }[]
  usage?: TestCompletionUsage | null
  toJSON?: () => TestCompletionChunk
}
type ReaderCancellationState = {
  reader?: ReadableStreamDefaultReader<Uint8Array>
  cancelPromise?: Promise<void>
}

const asCompletionChunk = (value: TestCompletionChunk): CompletionChunk => value as CompletionChunk

const createDeferred = <T = void>() => {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}

const createCompletion = (chunks: readonly CompletionChunk[], controller = new AbortController()): Completion => ({
  controller,
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) {
      yield chunk
    }
  },
})

const readStreamChunks = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return chunks
      }
      chunks.push(decoder.decode(value))
    }
  } finally {
    reader.releaseLock()
  }
}

describe('createSSEStreamFromCompletion', () => {
  it('treats absent and null usage as ordinary missing usage', async () => {
    const chunks = [
      asCompletionChunk({ id: 'without-usage', choices: [] }),
      asCompletionChunk({ id: 'null-usage', choices: [], usage: null }),
    ]
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const onUsageMissing = jest.fn()

    await readStreamChunks(createSSEStreamFromCompletion(createCompletion(chunks), { onUsage, onUsageMissing }))

    expect(onUsage).not.toHaveBeenCalled()
    expect(onUsageMissing).toHaveBeenCalledTimes(1)
    expect(onUsageMissing).toHaveBeenCalledWith()
  })

  it('uses the latest valid intermediate or final snapshot without inspecting choices', async () => {
    const firstUsage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    const latestUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    const chunks = [
      asCompletionChunk({ id: 'usage-before-content', usage: firstUsage }),
      asCompletionChunk({ id: 'content', choices: [{ delta: { content: 'Hello' } }] }),
      asCompletionChunk({ id: 'final-usage', usage: latestUsage }),
    ]
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})

    await readStreamChunks(createSSEStreamFromCompletion(createCompletion(chunks), { onUsage }))

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
  })

  it('keeps a valid snapshot when malformed usage appears before and after it', async () => {
    const chunks = [
      asCompletionChunk({
        id: 'malformed-before',
        usage: { prompt_tokens: '8', completion_tokens: 2, total_tokens: 10 },
      }),
      asCompletionChunk({
        id: 'valid',
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      }),
      asCompletionChunk({
        id: 'malformed-after',
        usage: { prompt_tokens: 20, completion_tokens: null, total_tokens: 20 },
      }),
    ]
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})

    await readStreamChunks(createSSEStreamFromCompletion(createCompletion(chunks), { onUsage }))

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    })
  })

  it('rejects negative, fractional, and unsafe token counts', async () => {
    const chunks = [
      asCompletionChunk({
        id: 'negative',
        usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
      }),
      asCompletionChunk({
        id: 'fractional',
        usage: { prompt_tokens: 1, completion_tokens: 2.5, total_tokens: 3.5 },
      }),
      asCompletionChunk({
        id: 'unsafe',
        usage: {
          prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
          completion_tokens: 1,
          total_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ]
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const onUsageMissing = jest.fn()

    await readStreamChunks(createSSEStreamFromCompletion(createCompletion(chunks), { onUsage, onUsageMissing }))

    expect(onUsage).not.toHaveBeenCalled()
    expect(onUsageMissing).toHaveBeenCalledTimes(1)
  })

  it('accepts a valid snapshot whose total does not equal its parts', async () => {
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const completion = createCompletion([
      asCompletionChunk({
        id: 'mismatched-total',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 },
      }),
    ])

    await readStreamChunks(createSSEStreamFromCompletion(completion, { onUsage }))

    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 99,
    })
  })

  it('reports malformed-only usage as missing without changing the response', async () => {
    const chunk = {
      id: 'malformed-only',
      choices: [{ delta: { content: 'still delivered' } }],
      usage: { prompt_tokens: 4, completion_tokens: undefined, total_tokens: 4 },
    }
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const onUsageMissing = jest.fn()

    const response = await readStreamChunks(
      createSSEStreamFromCompletion(createCompletion([asCompletionChunk(chunk)]), {
        onUsage,
        onUsageMissing,
      }),
    )

    expect(response).toEqual([`data: ${JSON.stringify(chunk)}\n\n`, 'data: [DONE]\n\n'])
    expect(onUsage).not.toHaveBeenCalled()
    expect(onUsageMissing).toHaveBeenCalledTimes(1)
  })

  it('keeps a naturally completed response intact when the missing observer throws', async () => {
    const chunk = { id: 'missing-usage', choices: [{ delta: { content: 'complete' } }] }
    const onUsageMissing = jest.fn(() => {
      throw new Error('missing usage observer failed')
    })

    const response = await readStreamChunks(
      createSSEStreamFromCompletion(createCompletion([asCompletionChunk(chunk)]), {
        onUsageMissing,
      }),
    )

    expect(response).toEqual([`data: ${JSON.stringify(chunk)}\n\n`, 'data: [DONE]\n\n'])
    expect(onUsageMissing).toHaveBeenCalledTimes(1)
  })

  it('does not consume observed usage when cancelled before natural exhaustion', async () => {
    const controller = new AbortController()
    const iteratorClosed = createDeferred()
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const completion = {
      controller,
      async *[Symbol.asyncIterator]() {
        try {
          yield asCompletionChunk({
            id: 'observed-before-cancel',
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          })
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          yield asCompletionChunk({ id: 'after-cancel', choices: [] })
        } finally {
          iteratorClosed.resolve()
        }
      },
    } satisfies Completion
    const reader = createSSEStreamFromCompletion(completion, { onUsage }).getReader()

    expect(new TextDecoder().decode((await reader.read()).value)).toContain('observed-before-cancel')
    await reader.cancel()
    await iteratorClosed.promise

    expect(controller.signal.aborted).toBe(true)
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('does not consume usage when a provider chunk cannot be enqueued before exhaustion', async () => {
    const releaseChunk = createDeferred()
    const iteratorClosed = createDeferred()
    const controller = new AbortController()
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const streamState: ReaderCancellationState = {}
    const chunk = {
      id: 'enqueue-failure',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      toJSON: () => {
        streamState.cancelPromise = streamState.reader?.cancel()
        return {
          id: 'enqueue-failure',
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }
      },
    }
    const completion = {
      controller,
      async *[Symbol.asyncIterator]() {
        await releaseChunk.promise
        try {
          yield asCompletionChunk(chunk)
          yield asCompletionChunk({ id: 'never-delivered', choices: [] })
        } finally {
          iteratorClosed.resolve()
        }
      },
    } satisfies Completion
    const stream = createSSEStreamFromCompletion(completion, { onUsage })
    const reader = stream.getReader()
    streamState.reader = reader
    const firstRead = reader.read()

    releaseChunk.resolve()

    expect(await firstRead).toEqual({ done: true, value: undefined })
    await streamState.cancelPromise
    await iteratorClosed.promise
    expect(controller.signal.aborted).toBe(true)
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('does not consume observed usage when the upstream iterator fails', async () => {
    const upstreamError = new Error('provider stream exposed a secret')
    const onError = jest.fn()
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const completion = {
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          yield asCompletionChunk({
            id: 'before-error',
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          })
          throw upstreamError
        },
      } satisfies Completion
      const reader = createSSEStreamFromCompletion(completion, { onError, onUsage }).getReader()

      expect((await reader.read()).done).toBe(false)
      await expect(reader.read()).rejects.toBe(upstreamError)

      expect(onUsage).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(upstreamError)
      expect(consoleErrorSpy).not.toHaveBeenCalled()
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('preserves the original upstream error when the error observer throws', async () => {
    const upstreamError = new Error('upstream failed')
    const observerError = new Error('error observer failed')
    const onError = jest.fn(() => {
      throw observerError
    })
    const completion = {
      controller: new AbortController(),
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<CompletionChunk>> => {
          throw upstreamError
        },
      }),
    } satisfies Completion
    const reader = createSSEStreamFromCompletion(completion, { onError }).getReader()

    await expect(reader.read()).rejects.toBe(upstreamError)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(upstreamError)
  })

  it('keeps one awaited usage attempt when synthetic DONE enqueue fails', async () => {
    const usageStarted = createDeferred()
    const releaseUsage = createDeferred()
    const doneEnqueueAttempted = createDeferred()
    const lifecycleEvents: string[] = []
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {
      lifecycleEvents.push('usage-started')
      usageStarted.resolve()
      await releaseUsage.promise
      lifecycleEvents.push('usage-finished')
    })
    const OriginalReadableStream = globalThis.ReadableStream
    const DoneFailingReadableStream = class<R = unknown> extends OriginalReadableStream<R> {
      constructor(source: UnderlyingDefaultSource<R> = {}, strategy?: QueuingStrategy<R>) {
        super(
          {
            ...source,
            start: (controller) => {
              const wrappedController: ReadableStreamDefaultController<R> = {
                get desiredSize() {
                  return controller.desiredSize
                },
                close: () => controller.close(),
                enqueue: (chunk) => {
                  if (chunk instanceof Uint8Array && new TextDecoder().decode(chunk) === 'data: [DONE]\n\n') {
                    lifecycleEvents.push('done-attempted')
                    doneEnqueueAttempted.resolve()
                    throw new Error('synthetic DONE enqueue failed')
                  }

                  controller.enqueue(chunk)
                },
                error: controller.error.bind(controller),
              }

              return source.start?.(wrappedController)
            },
          },
          strategy,
        )
      }
    }
    const completion = createCompletion([
      asCompletionChunk({
        id: 'complete',
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    ])
    const stream = (() => {
      globalThis.ReadableStream = DoneFailingReadableStream as typeof ReadableStream
      try {
        return createSSEStreamFromCompletion(completion, { onUsage })
      } finally {
        globalThis.ReadableStream = OriginalReadableStream
      }
    })()
    expect(globalThis.ReadableStream).toBe(OriginalReadableStream)
    const reader = stream.getReader()

    expect((await reader.read()).done).toBe(false)
    await usageStarted.promise
    expect(lifecycleEvents).toEqual(['usage-started'])

    releaseUsage.resolve()
    await doneEnqueueAttempted.promise

    expect(lifecycleEvents).toEqual(['usage-started', 'usage-finished', 'done-attempted'])
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(onUsage).toHaveBeenCalledTimes(1)
  })

  it('awaits a pending usage consumer and lets it settle after late cancellation', async () => {
    const controller = new AbortController()
    const usageStarted = createDeferred()
    const releaseUsage = createDeferred()
    const usageSettled = createDeferred()
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {
      usageStarted.resolve()
      await releaseUsage.promise
      usageSettled.resolve()
    })
    const completion = createCompletion(
      [
        asCompletionChunk({
          id: 'complete',
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      ],
      controller,
    )
    const reader = createSSEStreamFromCompletion(completion, { onUsage }).getReader()

    expect((await reader.read()).done).toBe(false)
    await usageStarted.promise
    const doneRead = reader.read()
    const readState = await Promise.race([
      doneRead.then(() => 'done-enqueued' as const),
      Promise.resolve('consumer-pending' as const),
    ])

    expect(readState).toBe('consumer-pending')
    const cancellation = reader.cancel()

    expect(controller.signal.aborted).toBe(false)
    releaseUsage.resolve()
    await usageSettled.promise
    await cancellation
    expect(await doneRead).toEqual({ done: true, value: undefined })
    expect(onUsage).toHaveBeenCalledTimes(1)
  })

  it('keeps the caller stream intact when the usage consumer rejects', async () => {
    const chunk = {
      id: 'consumer-rejection',
      choices: [{ delta: { content: 'complete response' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }
    const usageError = new Error('ledger unavailable')
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {
      throw usageError
    })
    const onUsageError = jest.fn()

    const response = await readStreamChunks(
      createSSEStreamFromCompletion(createCompletion([asCompletionChunk(chunk)]), {
        onUsage,
        onUsageError,
      }),
    )

    expect(response).toEqual([`data: ${JSON.stringify(chunk)}\n\n`, 'data: [DONE]\n\n'])
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsageError).toHaveBeenCalledTimes(1)
    expect(onUsageError).toHaveBeenCalledWith(usageError)
  })

  it('keeps the caller stream intact when the usage error observer throws', async () => {
    const chunk = {
      id: 'observer-rejection',
      choices: [{ delta: { content: 'complete response' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }
    const usageError = new Error('ledger unavailable')
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {
      throw usageError
    })
    const onUsageError = jest.fn(() => {
      throw new Error('usage error observer failed')
    })

    const response = await readStreamChunks(
      createSSEStreamFromCompletion(createCompletion([asCompletionChunk(chunk)]), {
        onUsage,
        onUsageError,
      }),
    )

    expect(response).toEqual([`data: ${JSON.stringify(chunk)}\n\n`, 'data: [DONE]\n\n'])
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsageError).toHaveBeenCalledTimes(1)
    expect(onUsageError).toHaveBeenCalledWith(usageError)
  })

  it('forwards usage-bearing chunks unchanged and in order', async () => {
    const chunks = [
      {
        id: 'first',
        choices: [{ delta: { content: 'Hello' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      },
      {
        id: 'second',
        choices: [{ delta: { content: ' world' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]

    const response = await readStreamChunks(
      createSSEStreamFromCompletion(createCompletion(chunks.map((chunk) => asCompletionChunk(chunk)))),
    )

    expect(response).toEqual([
      `data: ${JSON.stringify(chunks[0])}\n\n`,
      `data: ${JSON.stringify(chunks[1])}\n\n`,
      'data: [DONE]\n\n',
    ])
  })

  it('does not mutate frozen inputs and retains only copied token numbers', async () => {
    const frozenUsage = Object.freeze({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    })
    const frozenChunk = Object.freeze({ id: 'frozen', choices: [], usage: frozenUsage })
    const mutableUsage = { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
    const mutableChunk = { id: 'mutable', choices: [], usage: mutableUsage }
    const onUsage = jest.fn(async (_snapshot: CompletionUsageSnapshot) => {})
    const completion = {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield asCompletionChunk(frozenChunk)
        yield asCompletionChunk(mutableChunk)
        mutableUsage.prompt_tokens = 50
        mutableUsage.completion_tokens = 60
        mutableUsage.total_tokens = 110
      },
    } satisfies Completion

    await readStreamChunks(createSSEStreamFromCompletion(completion, { onUsage }))

    expect(frozenChunk.usage).toBe(frozenUsage)
    expect(frozenUsage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 5,
      completionTokens: 6,
      totalTokens: 11,
    })
  })
})
