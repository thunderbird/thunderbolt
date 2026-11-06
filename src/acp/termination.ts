/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Stable transport-level reasons consumed by ACP lifecycle code. */
export type TransportTerminationReason = 'remote-close' | 'stream-error'

export type TransportTerminationErrorOptions = ErrorOptions & {
  /** Whether redialing the same endpoint can succeed. Terminal close codes
   *  (auth revoked, proxy rejects, server errors) set this to false. */
  retryable?: boolean
}

/** A typed terminal transport failure that never requires message matching. */
export class TransportTerminationError extends Error {
  readonly reason: TransportTerminationReason
  readonly retryable: boolean

  constructor(reason: TransportTerminationReason, message: string, options?: TransportTerminationErrorOptions) {
    super(message, options)
    this.name = 'TransportTerminationError'
    this.reason = reason
    this.retryable = options?.retryable ?? true
  }
}

/** Find the transport termination inside an error's cause chain, when present —
 *  adapters wrap transport deaths in their own connection-lost error before
 *  lifecycle code sees them. */
export const getTransportTermination = (error: unknown): TransportTerminationError | undefined => {
  let current: unknown = error
  while (current instanceof Error) {
    if (current instanceof TransportTerminationError) {
      return current
    }
    current = current.cause
  }
  return undefined
}
