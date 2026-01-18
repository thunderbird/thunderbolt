/**
 * HTTP-based sync utilities for initial app sync operations
 * Used during app initialization to push/pull changes before WebSocket is established
 */

import type { KyInstance } from 'ky'
import { getLatestMigrationVersion } from './migrate'
import { DatabaseSingleton } from './singleton'
import {
  deserializeChange,
  getLastSyncedVersion,
  getServerVersion,
  getSiteId,
  serializeChange,
  type SerializedChange,
  setLastSyncedVersion,
  setServerVersion,
} from './sync-utils'

// Re-export for external consumers
export { getSiteId, type SerializedChange } from './sync-utils'

/**
 * Response from sync push endpoint
 */
type SyncPushResponse = {
  success: boolean
  serverVersion: string
  needsUpgrade?: boolean
  requiredVersion?: string
}

/**
 * Response from sync pull endpoint
 */
type SyncPullResponse = {
  changes: SerializedChange[]
  serverVersion: string
  needsUpgrade?: boolean
  requiredVersion?: string
}

/**
 * Push local changes to the server via HTTP
 * Used during initial sync before WebSocket is established
 */
export const pushChangesHttp = async (httpClient: KyInstance): Promise<void> => {
  if (!DatabaseSingleton.instance.supportsSyncing) {
    return
  }

  const db = DatabaseSingleton.instance.syncableDatabase
  const lastSyncedVersion = getLastSyncedVersion()
  const { changes, dbVersion } = await db.getChanges(lastSyncedVersion)

  if (changes.length === 0) {
    return
  }

  const siteId = await getSiteId()
  const serializedChanges = changes.map(serializeChange)
  const migrationVersion = getLatestMigrationVersion()

  const response = await httpClient
    .post('sync/push', {
      json: {
        siteId,
        changes: serializedChanges,
        dbVersion: dbVersion.toString(),
        migrationVersion,
      },
    })
    .json<SyncPushResponse>()

  if (response.needsUpgrade && response.requiredVersion) {
    throw new Error('VERSION_MISMATCH')
  }

  if (response.success) {
    setLastSyncedVersion(dbVersion)
    setServerVersion(BigInt(response.serverVersion))
  }
}

/**
 * Pull changes from the server via HTTP
 * Used during initial sync before WebSocket is established
 */
export const pullChangesHttp = async (httpClient: KyInstance): Promise<void> => {
  if (!DatabaseSingleton.instance.supportsSyncing) {
    return
  }

  const serverVersion = getServerVersion()
  const siteId = await getSiteId()
  const migrationVersion = getLatestMigrationVersion()

  const response = await httpClient
    .get('sync/pull', {
      searchParams: {
        since: serverVersion.toString(),
        siteId,
        migrationVersion,
      },
    })
    .json<SyncPullResponse>()

  if (response.needsUpgrade && response.requiredVersion) {
    throw new Error('VERSION_MISMATCH')
  }

  if (response.changes.length > 0) {
    const changes = response.changes.map(deserializeChange)
    const db = DatabaseSingleton.instance.syncableDatabase
    await db.applyChanges(changes)
  }

  setServerVersion(BigInt(response.serverVersion))
}

/**
 * Perform initial sync (push + pull) via HTTP
 * Used during app initialization before WebSocket is established
 */
export const performInitialSync = async (httpClient: KyInstance): Promise<void> => {
  await pushChangesHttp(httpClient)
  await pullChangesHttp(httpClient)
}
