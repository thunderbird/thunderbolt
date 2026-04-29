/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encryptedColumnsMap, isEncryptionEnabled } from './config'
import { codec } from './codec'

type CrudOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

/**
 * Encrypts encrypted columns in a CRUD operation before upload.
 * Returns the operation unchanged if the table has no encrypted columns or op is DELETE.
 */
export const encodeForUpload = async (operation: CrudOperation): Promise<CrudOperation> => {
  if (!isEncryptionEnabled() || operation.op === 'DELETE' || !operation.data) {
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
      if (typeof value === 'string') {
        encodedData[col] = await codec.encode(value)
      }
    }),
  )

  return { ...operation, data: encodedData }
}
