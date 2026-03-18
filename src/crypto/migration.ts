export type MigrationStatus = {
  total: number
  completed: number
  failed: number
  status: 'idle' | 'running' | 'done' | 'error'
}

/**
 * Migrate local unencrypted data when sync is enabled for the first time.
 * Stub — actual implementation will encrypt and upload local records in batches.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const migrateLocalData = async (_onProgress?: (status: MigrationStatus) => void): Promise<MigrationStatus> => {
  // TODO: Implement actual migration:
  // 1. Query local DB for records where sync_status = "local_only"
  // 2. For each record: serialize → encryptRecord → upload → update sync_status
  // 3. Process in batches of 20, yield between batches
  return { total: 0, completed: 0, failed: 0, status: 'done' }
}
