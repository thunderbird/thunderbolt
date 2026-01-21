import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web'

type TokenResponse = {
  token: string
  expiresAt: string
  powerSyncUrl: string
}

/**
 * PowerSync connector that handles authentication and data upload.
 * - fetchCredentials: Gets JWT tokens from the backend
 * - uploadData: Sends local changes to the backend for persistence
 */
export class ThunderboltConnector implements PowerSyncBackendConnector {
  constructor(private backendUrl: string) {}

  /**
   * Fetch credentials (JWT token) from the backend.
   * Returns null if unable to get credentials (e.g., PowerSync not configured).
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    try {
      const response = await fetch(`${this.backendUrl}/powersync/token`)

      if (!response.ok) {
        console.error('Failed to fetch PowerSync credentials:', response.status)
        return null
      }

      const data: TokenResponse = await response.json()

      return {
        endpoint: data.powerSyncUrl,
        token: data.token,
        expiresAt: new Date(data.expiresAt),
      }
    } catch (error) {
      console.error('Error fetching PowerSync credentials:', error)
      return null
    }
  }

  /**
   * Upload local changes to the backend.
   * This is called by PowerSync when there are pending changes in the upload queue.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    // Get the next batch of changes from the upload queue
    const transaction = await database.getNextCrudTransaction()

    if (!transaction) {
      return // No changes to upload
    }

    try {
      // Convert CRUD operations to our API format
      const operations = transaction.crud.map((op) => ({
        op: op.op.toUpperCase() as 'PUT' | 'PATCH' | 'DELETE',
        type: op.table,
        id: op.id,
        data: op.opData,
      }))

      console.info(`Uploading ${operations.length} operations to backend`)

      // Send to backend
      const response = await fetch(`${this.backendUrl}/powersync/upload`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operations }),
      })

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`)
      }

      // Mark the transaction as complete
      await transaction.complete()

      console.info('PowerSync upload completed successfully')
    } catch (error) {
      console.error('PowerSync upload failed:', error)
      // Don't call complete() - PowerSync will retry the upload
      throw error
    }
  }
}
