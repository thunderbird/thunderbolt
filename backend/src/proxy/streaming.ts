/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Reason the stream finished or was torn down. `aborted` covers both upstream
 *  errors and downstream cancellations — they are indistinguishable from the
 *  pipeTo rejection alone, and the observability layer treats them the same. */
export type CapStreamCompletionReason = 'done' | 'cap' | 'idle' | 'aborted'

/**
 * Wraps a ReadableStream with a byte-cap and idle-timeout TransformStream.
 * When either limit is exceeded the stream is terminated (not errored) so the
 * client receives a truncated but valid chunked response — the proxy cannot
 * retroactively change the HTTP status because headers have already been sent.
 * `onAbort` is called first so the caller can abort the upstream connection.
 *
 * `onComplete`, when provided, is invoked exactly once with the total bytes
 * forwarded to the client and the reason the stream ended (graceful done,
 * cap-fired, idle-fired, errored, or downstream-cancelled). It is the
 * single source of truth for `bytes_out` in proxy observability.
 */
export const capStream = (
  source: ReadableStream<Uint8Array>,
  opts: {
    maxBytes: number
    idleTimeoutMs: number
    onAbort: (reason: 'cap' | 'idle') => void
    onComplete?: (bytesOut: number, reason: CapStreamCompletionReason) => void
  },
): ReadableStream<Uint8Array> => {
  let bytesReceived = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let completed = false

  const complete = (reason: CapStreamCompletionReason) => {
    if (completed) return
    completed = true
    opts.onComplete?.(bytesReceived, reason)
  }

  const resetIdleTimer = (controller: TransformStreamDefaultController<Uint8Array>) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      opts.onAbort('idle')
      controller.terminate()
      complete('idle')
    }, opts.idleTimeoutMs)
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      resetIdleTimer(controller)
    },
    transform(chunk, controller) {
      // Evaluate the cap WITHOUT mutating the counter — when a chunk would push
      // us over, we discard it (terminate, no enqueue), so its bytes never
      // reach the client and must not be counted in bytesOut. Otherwise the
      // metric would over-report by one chunk on every cap fire, breaking
      // billing/quota/audit accuracy.
      if (bytesReceived + chunk.byteLength > opts.maxBytes) {
        clearTimeout(idleTimer)
        opts.onAbort('cap')
        controller.terminate()
        complete('cap')
        return
      }
      bytesReceived += chunk.byteLength
      controller.enqueue(chunk)
      resetIdleTimer(controller)
    },
    flush() {
      clearTimeout(idleTimer)
      complete('done')
    },
  })

  source.pipeTo(writable).catch(() => {
    // pipeTo rejects when source errors OR when writable is aborted (e.g., downstream
    // was cancelled). Clear the idle timer here so it doesn't fire after the stream
    // has been torn down — running terminate() on an errored controller throws.
    clearTimeout(idleTimer)
    complete('aborted')
  })

  return readable
}
