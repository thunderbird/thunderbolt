/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Thrown when encryption or wrapping fails. */
export class EncryptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EncryptionError'
  }
}

/** Thrown when decryption or unwrapping fails (wrong key, corrupted data, etc.). */
export class DecryptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DecryptionError'
  }
}

/** Thrown when IndexedDB or localStorage operations fail. */
export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}

/** Thrown when input validation fails (e.g. invalid recovery key format). */
export class ValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ValidationError'
  }
}
