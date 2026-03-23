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
