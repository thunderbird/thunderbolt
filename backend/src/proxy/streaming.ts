/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const defaultIdleTimeoutError = new DOMException('stream idle timeout', 'TimeoutError')

export type CappedStream = {
  stream: ReadableStream<Uint8Array>
  /** Total bytes that flowed through the cap. Read after stream completion. */
  bytesRead: () => number
}

/** Controls byte limiting and idle-expiry behavior for a relayed stream. */
export type CapStreamOptions = {
  /** Maximum bytes accepted before termination. Omit to disable byte limiting. */
  maxBytes?: number
  idleTimeoutMs: number
  /** Whether idle expiry terminates or errors the relayed stream. Defaults to termination. */
  onIdle?: 'terminate' | 'error'
  /** Error exposed to readers when `onIdle` is `error`. */
  idleError?: Error
  /** Handles error-mode idle expiry at the transport layer. Caller must tear
   *  down the transport because the relayed stream stays pending. */
  onIdleError?: (error: Error) => void
  onAbort: (reason: 'cap' | 'idle') => void
  /** Fired exactly once after the stream finishes (graceful close, cap-hit,
   *  idle, source error, or downstream cancel). Receives the total bytes
   *  that flowed through. Use for post-stream observability emission. */
  onComplete?: (bytesRead: number) => void
}

/**
 * Wraps a ReadableStream with an optional byte cap and idle watchdog.
 * Limit expiry terminates by default because response headers have already
 * been sent. Error mode rejects unsafe truncation by default or delegates it
 * to a transport handler. `onAbort` fires first so callers can abort upstream.
 *
 * Returns `bytesRead()` so observability can record the actual transferred byte
 * count after the stream has been consumed. With `content-encoding` passthrough
 * the bytes counted are post-compression (what the wire saw), which is exactly
 * what we want to log.
 */
export const capStream = (source: ReadableStream<Uint8Array>, opts: CapStreamOptions): CappedStream => {
  let bytesReceived = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let idleHandled = false
  const idleError = opts.idleError ?? defaultIdleTimeoutError
  const externalIdleHandler = opts.onIdle === 'error' ? opts.onIdleError : undefined

  const fireComplete = () => {
    if (completed) {
      return
    }
    completed = true
    opts.onComplete?.(bytesReceived)
  }

  const armIdleTimer = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (idleTimer) {
      idleTimer.refresh()
      return
    }

    idleTimer = setTimeout(() => {
      idleTimer = undefined
      idleHandled = externalIdleHandler !== undefined
      opts.onAbort('idle')
      if (opts.onIdle !== 'error') {
        controller.terminate()
      } else if (externalIdleHandler) {
        externalIdleHandler(idleError)
      } else {
        controller.error(idleError)
      }
      fireComplete()
    }, opts.idleTimeoutMs)
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      armIdleTimer(controller)
    },
    transform(chunk, controller) {
      bytesReceived += chunk.byteLength
      if (opts.maxBytes !== undefined && bytesReceived > opts.maxBytes) {
        clearTimeout(idleTimer)
        idleTimer = undefined
        opts.onAbort('cap')
        controller.terminate()
        fireComplete()
        return
      }
      controller.enqueue(chunk)
      armIdleTimer(controller)
    },
    flush() {
      clearTimeout(idleTimer)
      idleTimer = undefined
      fireComplete()
    },
  })

  // pipeTo rejects when the source errors OR the writable is aborted (downstream
  // cancel). Clear the idle timer so it can't fire after teardown — terminate()
  // on an errored controller throws.
  const finishRelay = () => {
    clearTimeout(idleTimer)
    idleTimer = undefined
    fireComplete()
  }

  if (externalIdleHandler) {
    /** Keeps the relayed body pending after idle expiry so Bun can reset the transport. */
    const relaySource = async () => {
      try {
        await source.pipeTo(writable, { preventAbort: true, preventClose: true })
        if (!idleHandled) {
          await writable.close()
        }
      } catch (error) {
        if (!idleHandled) {
          await writable.abort(error).catch(() => {})
        }
      }
    }

    void relaySource().finally(finishRelay)
  } else {
    source.pipeTo(writable).catch(finishRelay)
  }

  return {
    stream: readable,
    bytesRead: () => bytesReceived,
  }
}
