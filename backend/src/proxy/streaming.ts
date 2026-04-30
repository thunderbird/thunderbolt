/**
 * Wraps a ReadableStream with a byte-cap and idle-timeout TransformStream.
 * When either limit is exceeded the stream is terminated (not errored) so the
 * client receives a truncated but valid chunked response — the proxy cannot
 * retroactively change the HTTP status because headers have already been sent.
 * `onAbort` is called first so the caller can abort the upstream connection.
 */
export const capStream = (
  source: ReadableStream<Uint8Array>,
  opts: {
    maxBytes: number
    idleTimeoutMs: number
    onAbort: (reason: 'cap' | 'idle') => void
  },
): ReadableStream<Uint8Array> => {
  let bytesReceived = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const resetIdleTimer = (controller: TransformStreamDefaultController<Uint8Array>) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      opts.onAbort('idle')
      controller.terminate()
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
        return
      }
      controller.enqueue(chunk)
      resetIdleTimer(controller)
    },
    flush() {
      clearTimeout(idleTimer)
    },
  })

  source.pipeTo(writable).catch(() => {
    // Upstream abort or early termination — silently swallow; downstream already closed.
  })

  return readable
}
