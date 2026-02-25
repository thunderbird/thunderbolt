import { getDeviceId, getAuthToken } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'
import ky from 'ky'
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web'

/** Dispatched when backend returns 410 (account deleted), 403 + DEVICE_DISCONNECTED, or 409 + DEVICE_ID_TAKEN. App should reset and reload. */
export const POWERSYNC_CREDENTIALS_INVALID = 'powersync_credentials_invalid'

type TokenResponse = {
  token: string
  expiresAt: string
  powerSyncUrl: string
}

type ErrorBody = { code?: string; error?: string }

/**
 * Checks if the response indicates credentials are invalid (account deleted, device revoked, etc.).
 * If so, dispatches POWERSYNC_CREDENTIALS_INVALID and returns true.
 */
export const handleCredentialsInvalidIfNeeded = (status: number, body: ErrorBody): boolean => {
  const isResetSignal =
    status === 410 ||
    (status === 403 && body.code === 'DEVICE_DISCONNECTED') ||
    (status === 409 && body.code === 'DEVICE_ID_TAKEN') ||
    (status === 400 && body.code === 'DEVICE_ID_REQUIRED')
  if (isResetSignal) {
    window.dispatchEvent(new CustomEvent(POWERSYNC_CREDENTIALS_INVALID))
    return true
  }
  return false
}

/**
 * Build headers with Authorization Bearer token and device id/name if available.
 */
const buildHeaders = (additionalHeaders?: Record<string, string>): Record<string, string> => {
  const headers: Record<string, string> = { ...additionalHeaders }
  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const deviceId = getDeviceId()
  if (deviceId) {
    headers['X-Device-ID'] = deviceId
    headers['X-Device-Name'] = getDeviceDisplayName()
  }
  return headers
}

/**
 * PowerSync connector that handles authentication and data upload.
 * - fetchCredentials: Gets JWT tokens from the backend (requires auth)
 * - uploadData: Sends local changes to the backend for persistence (requires auth)
 */
export class ThunderboltConnector implements PowerSyncBackendConnector {
  constructor(private backendUrl: string) {}

  /**
   * Fetch credentials (JWT token) from the backend.
   * Returns null if unable to get credentials (e.g., not authenticated or PowerSync not configured).
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const hadToken = Boolean(getAuthToken())
    try {
      if (!hadToken) {
        return null
      }

      const response = await ky.get(`${this.backendUrl}/powersync/token`, {
        headers: buildHeaders(),
        throwHttpErrors: false,
      })

      if (!response.ok) {
        const status = response.status
        let body: ErrorBody = {}
        try {
          body = (await response.json()) as ErrorBody
        } catch {
          // ignore
        }
        handleCredentialsInvalidIfNeeded(status, body)
        if (status !== 401) {
          console.error('Failed to fetch PowerSync credentials:', status, body)
        }
        return null
      }

      const data: TokenResponse = (await response.json()) as TokenResponse
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

      const response = await ky.put(`${this.backendUrl}/powersync/upload`, {
        headers: buildHeaders(),
        json: { operations },
        throwHttpErrors: false,
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody
        handleCredentialsInvalidIfNeeded(response.status, body)
        throw new Error(`Upload failed: ${response.status} ${JSON.stringify(body)}`)
      }

      await transaction.complete()
      console.info('PowerSync upload completed successfully')
    } catch (error) {
      console.error('PowerSync upload failed:', error)
      // Don't call complete() - PowerSync will retry the upload
      throw error
    }
  }
}
