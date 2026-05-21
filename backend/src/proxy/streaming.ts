/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wraps a ReadableStream with a byte-cap and idle-timeout TransformStream.
 * When either limit is exceeded the stream is terminated (not errored) so the
 * client receives a truncated but valid chunked response — the proxy cannot
 * retroactively change the HTTP status because headers have already been sent.
 * `onAbort` is called first so the caller can abort the upstream connection.
 *
 * Returns `bytesRead()` so observability can record the actual transferred byte
 * count after the stream has been consumed. With `content-encoding` passthrough
 * the bytes counted are post-compression (what the wire saw), which is exactly
 * what we want to log.
 */
export type CappedStream = {
  stream: ReadableStream<Uint8Array>
  /** Total bytes that flowed through the cap. Read after stream completion. */
  bytesRead: () => number
}

export const capStream = (
  source: ReadableStream<Uint8Array>,
  opts: {
    maxBytes: number
    idleTimeoutMs: number
    onAbort: (reason: 'cap' | 'idle') => void
    /** Fired exactly once after the stream finishes (graceful close, cap-hit,
     *  idle, source error, or downstream cancel). Receives the total bytes
     *  that flowed through. Use for post-stream observability emission. */
    onComplete?: (bytesRead: number) => void
  },
): CappedStream => {
  let bytesReceived = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let completed = false

  const fireComplete = () => {
    if (completed) {
      return
    }
    completed = true
    opts.onComplete?.(bytesReceived)
  }

  const resetIdleTimer = (controller: TransformStreamDefaultController<Uint8Array>) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      opts.onAbort('idle')
      controller.terminate()
      fireComplete()
    }, opts.idleTimeoutMs)
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      resetIdleTimer(controller)
    },
    transform(chunk, controller) {
      bytesReceived += chunk.byteLength
      if (bytesReceived > opts.maxBytes) {
        clearTimeout(idleTimer)
        opts.onAbort('cap')
        controller.terminate()
        fireComplete()
        return
      }
      controller.enqueue(chunk)
      resetIdleTimer(controller)
    },
    flush() {
      clearTimeout(idleTimer)
      fireComplete()
    },
  })

  source.pipeTo(writable).catch(() => {
    // pipeTo rejects when source errors OR when writable is aborted (e.g., downstream
    // was cancelled). Clear the idle timer here so it doesn't fire after the stream
    // has been torn down — running terminate() on an errored controller throws.
    clearTimeout(idleTimer)
    fireComplete()
  })

  return {
    stream: readable,
    bytesRead: () => bytesReceived,
  }
}
