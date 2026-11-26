/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let lifetime = new AbortController()

/** An operation belongs to a key store that has since been reset. */
export class EncryptionOperationCancelledError extends Error {
  constructor() {
    super('Encryption operation cancelled because the account or key store changed')
    this.name = 'EncryptionOperationCancelledError'
  }
}

/** Invalidate pending key operations synchronously, before reset starts awaiting cleanup. */
export const invalidateEncryptionOperations = (): void => {
  const previous = lifetime
  lifetime = new AbortController()
  previous.abort(new EncryptionOperationCancelledError())
}

/** Capture the key-store lifetime and refuse work after a reset. */
export const captureKeyStorageLifetime = (): (() => void) => {
  const signal = lifetime.signal
  return () => signal.throwIfAborted()
}

/** Cancel network waits when the key-store lifetime ends, before cleanup needs its lock. */
export const getEncryptionOperationSignal = (): AbortSignal => lifetime.signal
