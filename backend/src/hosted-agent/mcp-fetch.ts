/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { withDeadline } from '@/utils/deadline'

/** A server response whose body ran past the cap `createMcpFetch` was given. */
export class McpResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`The response ran past ${maxBytes} bytes`)
    this.name = 'McpResponseTooLargeError'
  }
}

/** `body`, erroring with {@link McpResponseTooLargeError} once more than `maxBytes` of it has arrived. */
const capBody = (body: ReadableStream<Uint8Array>, maxBytes: number) => {
  const received = { bytes: 0 }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        received.bytes += chunk.byteLength
        if (received.bytes > maxBytes) {
          controller.error(new McpResponseTooLargeError(maxBytes))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

/** `response` with its body capped at `maxBytes`: refused unread when its `Content-Length` is larger. */
const capResponse = async (response: Response, maxBytes: number): Promise<Response> => {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new McpResponseTooLargeError(maxBytes)
  }
  return response.body ? new Response(capBody(response.body, maxBytes), response) : response
}

type McpFetchOptions = {
  /** Largest response body a server may send, in bytes. */
  maxResponseBytes: number
  /** Longest the `DELETE` that ends a session may take to answer. */
  closeTimeoutMs: number
}

/**
 * The fetch an MCP transport sends through. The client reads a whole result or tool list before anything can cap it,
 * so each response body is capped at `maxResponseBytes`: refused unread when its `Content-Length` is larger, cut off
 * where it crosses the cap otherwise. A JSON response that crosses it fails its request at once; a streamed one only
 * stops arriving, and its request ends at its own deadline. The transport sends the `DELETE` that ends a session
 * with no signal, and nothing awaits it, so it gets `closeTimeoutMs`, and a server that never answers holds nothing
 * open.
 */
export const createMcpFetch = (
  fetchFn: typeof fetch,
  { maxResponseBytes, closeTimeoutMs }: McpFetchOptions,
): typeof fetch => {
  const mcpFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.method !== 'DELETE') {
      return capResponse(await fetchFn(input, init), maxResponseBytes)
    }
    const response = await withDeadline(closeTimeoutMs, (deadline) =>
      fetchFn(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline }),
    )
    // The transport never reads it, and a body left unread would hold the connection open.
    await response.body?.cancel()
    return response
  }
  return Object.assign(mcpFetch, { preconnect: fetchFn.preconnect })
}
