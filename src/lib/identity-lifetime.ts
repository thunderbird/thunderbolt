/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let identity = new AbortController()

/** Capture before asynchronous work that must stop when this device leaves its current identity. */
export const getIdentitySignal = (): AbortSignal => identity.signal

/** Bind every phase of a cancellable operation to the identity that started it. */
export const createIdentityController = (signal?: AbortSignal): Pick<AbortController, 'signal' | 'abort'> => {
  const controller = new AbortController()
  return {
    signal: AbortSignal.any([controller.signal, getIdentitySignal(), ...(signal ? [signal] : [])]),
    abort: (reason?: unknown) => controller.abort(reason),
  }
}

/** Retire in-flight work synchronously, while allowing the next identity to start new requests. */
export const invalidateIdentityLifetime = (): void => {
  const previous = identity
  identity = new AbortController()
  previous.abort()
}
