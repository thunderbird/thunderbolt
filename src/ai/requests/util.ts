import { simulateReadableStream, type StreamTextResult, type ToolSet, type UIMessage } from 'ai'

type SimulatedFetchOptions = {
  initialDelayInMs?: number
  chunkDelayInMs?: number
}

export const createSimulatedFetch = (chunks: string[], options: SimulatedFetchOptions = {}): typeof fetch => {
  const simulatedFetch: typeof fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      simulateReadableStream({
        initialDelayInMs: options.initialDelayInMs,
        chunkDelayInMs: options.chunkDelayInMs,
        chunks,
      }).pipeThrough(new TextEncoderStream()),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      },
    )
  }

  // Bun's `fetch` type expects a `preconnect` method.
  simulatedFetch.preconnect = () => Promise.resolve(false)

  return simulatedFetch
}

export const parseSseLog = (sseLog: string): string[] => {
  return sseLog
    .trim() // get rid of leading/trailing whitespace so we don't generate an empty chunk
    .split(/\n\n+/) // split **only** on the blank line that separates SSE events
    .filter(Boolean) // defensive: remove potential empty strings
    .map((chunk) => `${chunk}\n\n`) // re-append the delimiter for each chunk
}

/**
 * Creates a TransformStream that converts AI SDK streaming chunks into UIMessage snapshots.
 * Each chunk processed emits a complete UIMessage with accumulated parts.
 */
export const createUIMessageTransform = (): TransformStream<any, UIMessage> => {
  let messageId: string = 'sim'
  let currentTextPart: { type: 'text'; text: string } | null = null
  let currentReasoningPart: { type: 'reasoning'; text: string } | null = null
  const parts: any[] = []

  return new TransformStream({
    transform(chunk: any, controller) {
      switch (chunk.type) {
        case 'text-delta':
        case 'text':
          // Accumulate successive text deltas into a single text part
          if (!currentTextPart) {
            currentTextPart = { type: 'text', text: '' }
            parts.push(currentTextPart)
          }
          currentTextPart.text += chunk.textDelta ?? chunk.text ?? ''
          break

        case 'reasoning':
          // Accumulate successive reasoning chunks into one part
          if (!currentReasoningPart) {
            currentReasoningPart = { type: 'reasoning', text: '' }
            parts.push(currentReasoningPart)
          }
          currentReasoningPart.text += chunk.text ?? ''
          break

        case 'finish':
          if (chunk.messageId) {
            messageId = chunk.messageId
          }
          break

        default:
          // Ignore other chunk types
          break
      }

      // Emit the current UIMessage snapshot
      controller.enqueue({
        id: messageId,
        role: 'assistant',
        parts: [...parts], // Spread to ensure new reference
      } as UIMessage)
    },
  })
}

/**
 * Consumes a StreamTextResult and returns the final accumulated UIMessage.
 * Useful for testing scenarios where you want the complete result without streaming UI updates.
 */
export const streamTextToUIMessage = async (streamTextResult: StreamTextResult<ToolSet, any>): Promise<UIMessage> => {
  const messageStream = streamTextResult.fullStream.pipeThrough(createUIMessageTransform())

  let finalMessage

  const reader = messageStream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      finalMessage = value
    }
  } finally {
    reader.releaseLock()
  }

  if (!finalMessage) {
    throw new Error('Failed to convert text stream into UIMessage.')
  }

  return finalMessage
}
