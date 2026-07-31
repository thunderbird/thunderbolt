/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Stable transport-level reasons consumed by ACP lifecycle code. */
export type TransportTerminationReason = 'remote-close' | 'stream-error'

/** A typed terminal transport failure that never requires message matching. */
export class TransportTerminationError extends Error {
  readonly reason: TransportTerminationReason

  constructor(reason: TransportTerminationReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TransportTerminationError'
    this.reason = reason
  }
}
