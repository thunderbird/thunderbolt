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

const deviceApprovalErrorMessages = {
  'fingerprint-mismatch': 'Device fingerprint does not match',
  'code-mismatch': 'Device approval code does not match',
  'recipient-unverified': 'Device envelope attestation could not be verified',
} as const

/** Distinguish user confirmation failures from receiver identity-verification failures. */
export class DeviceApprovalError extends ValidationError {
  readonly reason: 'fingerprint-mismatch' | 'code-mismatch' | 'recipient-unverified'

  constructor(reason: DeviceApprovalError['reason'], options?: ErrorOptions) {
    super(deviceApprovalErrorMessages[reason], options)
    this.name = 'DeviceApprovalError'
    this.reason = reason
  }
}

/** Thrown when key derivation (KDF / HKDF) fails. */
export class KeyDerivationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KeyDerivationError'
  }
}
