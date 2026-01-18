/**
 * HTTP-based sync utilities for initial app sync operations
 * Used during app initialization to push/pull changes before WebSocket is established
 */

import type { KyInstance } from 'ky'
import {
  handlePullResponse,
  handlePushSuccess,
  isPullVersionMismatch,
  isPushVersionMismatch,
  preparePull,
  preparePush,
  type PullResponse,
  type PushResponse,
} from './core'

// Re-export for external consumers
export { getSiteId, type SerializedChange } from './utils'

/**
 * Push local changes to the server via HTTP
 * Used during initial sync before WebSocket is established
 */
export const pushChangesHttp = async (httpClient: KyInstance): Promise<void> => {
  const prepared = await preparePush()

  if (!prepared) {
    return
  }

  const response = await httpClient
    .post('sync/push', {
      json: {
        siteId: prepared.siteId,
        changes: prepared.changes,
        dbVersion: prepared.dbVersion,
        migrationVersion: prepared.migrationVersion,
      },
    })
    .json<PushResponse>()

  if (isPushVersionMismatch(response)) {
    throw new Error('VERSION_MISMATCH')
  }

  if (response.success) {
    handlePushSuccess(response, prepared.rawDbVersion)
  }
}

/**
 * Pull changes from the server via HTTP
 * Used during initial sync before WebSocket is established
 */
export const pullChangesHttp = async (httpClient: KyInstance): Promise<void> => {
  const prepared = await preparePull()

  const response = await httpClient
    .get('sync/pull', {
      searchParams: {
        since: prepared.since,
        siteId: prepared.siteId,
        migrationVersion: prepared.migrationVersion,
      },
    })
    .json<PullResponse>()

  if (isPullVersionMismatch(response)) {
    throw new Error('VERSION_MISMATCH')
  }

  await handlePullResponse(response)
}

/**
 * Perform initial sync (push + pull) via HTTP
 * Used during app initialization before WebSocket is established
 */
export const performInitialSync = async (httpClient: KyInstance): Promise<void> => {
  await pushChangesHttp(httpClient)
  await pullChangesHttp(httpClient)
}
