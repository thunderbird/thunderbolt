/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Settles from cancellation even when an operation ignores its signal. */
export const abortable = async <Value>(operation: Promise<Value>, signal?: AbortSignal): Promise<Value> => {
  if (signal === undefined) return operation
  const cancellation = Promise.withResolvers<never>()
  const abort = (): void => cancellation.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    return await Promise.race([operation, cancellation.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Waits for an operation while deliberately discarding its rejection. */
export const settleBestEffort = async (operation: Promise<unknown>): Promise<void> => {
  await Promise.allSettled([operation])
}

export type SerialQueue = {
  readonly run: <Value>(operation: () => Promise<Value>) => Promise<Value>
}

/** Serializes operations while allowing the queue to continue after rejection. */
export const createSerialQueue = (): SerialQueue => {
  let tail: Promise<void> = Promise.resolve()
  return {
    run: (operation) => {
      const previous = tail
      const completion = Promise.withResolvers<void>()
      tail = completion.promise
      return (async () => {
        try {
          await previous
          return await operation()
        } finally {
          completion.resolve()
        }
      })()
    },
  }
}
