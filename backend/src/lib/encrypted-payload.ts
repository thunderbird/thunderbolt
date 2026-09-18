/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encryptedColumnsMap, encV2Prefix } from '@shared/e2ee-types'

/** One CRUD operation as it arrives on `PUT /powersync/upload`. */
type UploadOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

/** Where an unencrypted value was found, for the rejection envelope. */
export type PlaintextViolation = {
  table: string
  id: string
  column: string
}

/**
 * Find the first configured-encrypted column carrying a value that is not v2
 * ciphertext. Returns null when the batch is clean.
 *
 * Server-side backstop for the invariant the v2 migration depends on: once an
 * account is on the AK/DEK keyring, every write to a column in
 * `encryptedColumnsMap` must be `__enc:v2:…`. The client already enforces this
 * (`codec.encode` fails closed, and the connector refuses to flush a batch it
 * cannot encrypt), but a client bug here is unrecoverable — plaintext committed
 * to Postgres cannot be un-leaked. So the server checks too.
 *
 * Mirrors the client's encode selection exactly, or it would reject legitimate
 * writes: only columns actually present in `data` are checked, DELETEs carry no
 * data, and non-string values (null, numbers) are never encryptable.
 */
export const findPlaintextViolation = (operations: readonly UploadOperation[]): PlaintextViolation | null => {
  for (const operation of operations) {
    const columns = operation.op === 'DELETE' ? undefined : encryptedColumnsMap[operation.type]
    if (!columns || !operation.data) {
      continue
    }
    for (const column of columns) {
      const value = operation.data[column]
      if (typeof value !== 'string' || value.startsWith(encV2Prefix)) {
        continue
      }
      return { table: operation.type, id: operation.id, column }
    }
  }
  return null
}
