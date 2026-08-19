/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encryptedColumnsMap } from './config'
import { codec } from './codec'

type CrudOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

/**
 * Only string values are encryptable — configured columns holding non-string
 * values (null, numbers, …) are skipped explicitly. With the v1 `__enc:` prefix
 * idempotency net gone (THU-429, encode always encrypts), encode running exactly
 * once per CRUD op is the invariant; it is structurally guaranteed because
 * `codec.encode` is called solely from here, once per configured column.
 */
const isEncryptableValue = (value: unknown): value is string => typeof value === 'string'

/**
 * Encrypts encrypted columns in a CRUD operation before upload, binding
 * `{ table: operation.type, column, rowId: operation.id }` into AAD (THU-426).
 * The key_id is chosen inside the codec (the current primary DEK).
 * Returns the operation unchanged if the table has no encrypted columns or op is DELETE.
 */
export const encodeForUpload = async (operation: CrudOperation): Promise<CrudOperation> => {
  if (operation.op === 'DELETE' || !operation.data) {
    return operation
  }

  const columns = encryptedColumnsMap[operation.type]
  if (!columns) {
    return operation
  }

  const encodedData = { ...operation.data }
  await Promise.all(
    columns.map(async (col) => {
      const value = encodedData[col]
      if (!isEncryptableValue(value)) {
        return
      }
      encodedData[col] = await codec.encode(value, { table: operation.type, column: col, rowId: operation.id })
    }),
  )

  return { ...operation, data: encodedData }
}
