import { encryptedColumnsMap } from './config'
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
  if (operation.op === 'DELETE' || !operation.data) {
    return operation
  }

  const columns = encryptedColumnsMap[operation.type]
  if (!columns) {
    return operation
  }

  const encodedData = { ...operation.data }
  for (const col of columns) {
    const value = encodedData[col]
    if (typeof value === 'string') {
      encodedData[col] = await codec.encode(value)
    }
  }

  return { ...operation, data: encodedData }
}
