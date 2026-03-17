import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { encryptionConfig } from './config'
import { codec } from './codec'

/** Pre-computed lookup: tableName → encrypted column names */
const encryptedColumnsMap = new Map<string, readonly string[]>(
  Object.values(encryptionConfig).map((config) => [getTableConfig(config.table).name, config.columns]),
)

type CrudOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

/**
 * Encodes encrypted columns in a CRUD operation before upload.
 * Returns the operation unchanged if the table has no encrypted columns or op is DELETE.
 */
export const encodeForUpload = (operation: CrudOperation): CrudOperation => {
  if (operation.op === 'DELETE' || !operation.data) {
    return operation
  }

  const columns = encryptedColumnsMap.get(operation.type)
  if (!columns) {
    return operation
  }

  const encodedData = { ...operation.data }
  for (const col of columns) {
    const value = encodedData[col]
    if (typeof value === 'string') {
      encodedData[col] = codec.encode(value)
    }
  }

  return { ...operation, data: encodedData }
}
