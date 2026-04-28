/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDeviceId, getAuthToken } from '@/lib/auth-token'
import { isSsoMode } from '@/lib/auth-mode'
import { getDeviceDisplayName } from '@/lib/platform'
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web'
import { encodeForUpload } from '@/db/encryption'
import { sanitizeErrorForTracking, trackSyncEvent } from './sync-tracker'

/** Dispatched when backend returns 410 (account deleted), 403 + DEVICE_DISCONNECTED, 403 + DEVICE_NOT_TRUSTED, or 409 + DEVICE_ID_TAKEN. App should reset and reload. */
export const powersyncCredentialsInvalid = 'powersync_credentials_invalid'

export type CredentialsInvalidReason = 'account_deleted' | 'device_revoked' | 'device_id_taken' | 'device_id_required'

type TokenResponse = {
  token: string
  expiresAt: string
  powerSyncUrl: string
}

type ErrorBody = { code?: string; error?: string }

/**
 * Checks if the response indicates credentials are invalid (account deleted, device revoked, etc.).
 * If so, dispatches powersyncCredentialsInvalid and returns true.
 */
const getCredentialsInvalidReason = (status: number, body: ErrorBody): CredentialsInvalidReason | null => {
  if (status === 410) {
    return 'account_deleted'
  }
  if (status === 403 && body.code === 'DEVICE_DISCONNECTED') {
    return 'device_revoked'
  }
  if (status === 409 && body.code === 'DEVICE_ID_TAKEN') {
    return 'device_id_taken'
  }
  if (status === 400 && body.code === 'DEVICE_ID_REQUIRED') {
    return 'device_id_required'
  }
  return null
}

export const handleCredentialsInvalidIfNeeded = (status: number, body: ErrorBody): boolean => {
  const reason = getCredentialsInvalidReason(status, body)
  if (reason) {
    window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason } }))
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
    const ssoMode = isSsoMode()
    try {
      if (!hadToken && !ssoMode) {
        return null
      }

      const response = await fetch(`${this.backendUrl}/powersync/token`, {
        headers: buildHeaders(),
        credentials: ssoMode ? 'include' : undefined,
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
        // 401 = not authenticated (expected before login), DEVICE_NOT_TRUSTED = expected during setup
        if (status !== 401 && body.code !== 'DEVICE_NOT_TRUSTED') {
          console.error('Failed to fetch PowerSync credentials:', status, body)
        }
        trackSyncEvent('sync_credentials_error', {
          status,
          error_code: body.code,
          had_token: hadToken,
        })
        return null
      }

      const data: TokenResponse = (await response.json()) as TokenResponse
      const expiresAt = new Date(data.expiresAt)
      trackSyncEvent('sync_credentials_fetch', {
        expires_in_ms: expiresAt.getTime() - Date.now(),
      })
      return {
        endpoint: data.powerSyncUrl,
        token: data.token,
        expiresAt,
      }
    } catch (error) {
      console.error('Error fetching PowerSync credentials:', error)
      trackSyncEvent('sync_credentials_error', { had_token: hadToken, error: sanitizeErrorForTracking(error) })
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
      // Convert CRUD operations to our API format (encrypt encrypted columns)
      const operations = await Promise.all(
        transaction.crud.map((op) =>
          encodeForUpload({
            op: op.op.toUpperCase() as 'PUT' | 'PATCH' | 'DELETE',
            type: op.table,
            id: op.id,
            data: op.opData,
          }),
        ),
      )

      console.info(`Uploading ${operations.length} operations to backend`)

      const response = await fetch(`${this.backendUrl}/powersync/upload`, {
        method: 'PUT',
        headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations }),
        credentials: isSsoMode() ? 'include' : undefined,
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody
        handleCredentialsInvalidIfNeeded(response.status, body)
        throw new Error(`Upload failed: ${response.status} ${JSON.stringify(body)}`)
      }

      await transaction.complete()
      console.info('PowerSync upload completed successfully')
      trackSyncEvent('sync_upload', { operation_count: operations.length })
    } catch (error) {
      console.error('PowerSync upload failed:', error)
      trackSyncEvent('sync_upload_error', {
        error: sanitizeErrorForTracking(error),
        operation_count: transaction.crud.length,
      })
      // Don't call complete() - PowerSync will retry the upload
      throw error
    }
  }
}
