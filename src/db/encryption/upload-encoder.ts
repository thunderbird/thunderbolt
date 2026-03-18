import { getTableColumns } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { encryptionConfig } from './config'
import { codec } from './codec'
import { isEncryptionEnabled } from './enabled'

/** Pre-computed lookup: tableName → encrypted DB column names (snake_case) */
const encryptedColumnsMap = new Map<string, readonly string[]>(
  Object.values(encryptionConfig).map((config) => {
    const tableName = getTableConfig(config.table).name
    const cols = getTableColumns(config.table) as Record<string, { name: string }>
    // Map Drizzle field names (camelCase) to DB column names (snake_case)
    const dbNames = (config.columns as readonly string[]).map((field) => cols[field].name)
    return [tableName, dbNames]
  }),
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
  if (!isEncryptionEnabled() || operation.op === 'DELETE' || !operation.data) {
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
