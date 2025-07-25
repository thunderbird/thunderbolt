import { simulateReadableStream } from 'ai'

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
