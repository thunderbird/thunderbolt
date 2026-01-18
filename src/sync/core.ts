/**
 * Core sync logic shared between HTTP (initial-sync) and WebSocket (sync-service)
 * Changes are made in one place and reflected in both transport layers
 */

import type { CRSQLChange } from '@/db/crsqlite-worker'
import { getLatestMigrationVersion } from '@/db/migrate'
import { DatabaseSingleton } from '@/db/singleton'
import {
  deserializeChange,
  getLastSyncedVersion,
  getServerVersion,
  getSiteId,
  serializeChange,
  type SerializedChange,
  setLastSyncedVersion,
  setServerVersion,
} from './utils'

// Re-export types for consumers
export type { SerializedChange } from './utils'

// ============================================================================
// Push Logic
// ============================================================================

/**
 * Data prepared for a push operation
 */
export type PreparedPush = {
  siteId: string
  changes: SerializedChange[]
  dbVersion: string
  migrationVersion: string
  /** Raw dbVersion as bigint for tracking */
  rawDbVersion: bigint
}

/**
 * Response from a push operation (common format)
 */
export type PushResponse = {
  success: boolean
  serverVersion: string
  needsUpgrade?: boolean
  requiredVersion?: string
}

/**
 * Prepare local changes for push
 * Returns null if no changes to push or sync not supported
 */
export const preparePush = async (): Promise<PreparedPush | null> => {
  if (!DatabaseSingleton.instance.supportsSyncing) {
    return null
  }

  const db = DatabaseSingleton.instance.syncableDatabase
  const lastSyncedVersion = getLastSyncedVersion()
  const { changes, dbVersion } = await db.getChanges(lastSyncedVersion)

  if (changes.length === 0) {
    return null
  }

  const siteId = await getSiteId()
  const serializedChanges = changes.map(serializeChange)
  const migrationVersion = getLatestMigrationVersion()

  return {
    siteId,
    changes: serializedChanges,
    dbVersion: dbVersion.toString(),
    migrationVersion,
    rawDbVersion: dbVersion,
  }
}

/**
 * Handle a successful push response
 * Updates local version tracking
 */
export const handlePushSuccess = (response: PushResponse, pushedDbVersion: bigint): void => {
  setLastSyncedVersion(pushedDbVersion)
  setServerVersion(BigInt(response.serverVersion))
}

/**
 * Check if push response indicates version mismatch
 */
export const isPushVersionMismatch = (response: PushResponse): response is PushResponse & { requiredVersion: string } =>
  !!response.needsUpgrade && !!response.requiredVersion

// ============================================================================
// Pull Logic
// ============================================================================

/**
 * Data prepared for a pull operation
 */
export type PreparedPull = {
  since: string
  siteId: string
  migrationVersion: string
}

/**
 * Response from a pull operation (common format)
 */
export type PullResponse = {
  changes: SerializedChange[]
  serverVersion: string
  needsUpgrade?: boolean
  requiredVersion?: string
}

/**
 * Prepare data for a pull request
 */
export const preparePull = async (): Promise<PreparedPull> => {
  const serverVersion = getServerVersion()
  const siteId = await getSiteId()
  const migrationVersion = getLatestMigrationVersion()

  return {
    since: serverVersion.toString(),
    siteId,
    migrationVersion,
  }
}

/**
 * Apply changes received from a pull response
 * Returns the list of affected tables
 */
export const applyPullChanges = async (serializedChanges: SerializedChange[]): Promise<string[]> => {
  if (serializedChanges.length === 0) {
    return []
  }

  const changes = serializedChanges.map(deserializeChange)
  const db = DatabaseSingleton.instance.syncableDatabase
  await db.applyChanges(changes)

  // Return unique table names
  return [...new Set(serializedChanges.map((c) => c.table))]
}

/**
 * Handle a pull response
 * Applies changes and updates version tracking
 * Returns the list of affected tables
 */
export const handlePullResponse = async (response: PullResponse): Promise<string[]> => {
  const affectedTables = await applyPullChanges(response.changes)
  setServerVersion(BigInt(response.serverVersion))
  return affectedTables
}

/**
 * Check if pull response indicates version mismatch
 */
export const isPullVersionMismatch = (response: PullResponse): response is PullResponse & { requiredVersion: string } =>
  !!response.needsUpgrade && !!response.requiredVersion

// ============================================================================
// Change Application
// ============================================================================

/**
 * Apply raw CRDT changes to the local database
 */
export const applyRemoteChanges = async (changes: CRSQLChange[]): Promise<void> => {
  if (changes.length === 0) {
    return
  }

  const db = DatabaseSingleton.instance.syncableDatabase
  await db.applyChanges(changes)
}

/**
 * Extract chat thread IDs from changes for session recreation
 */
export const extractChatThreadIds = (changes: SerializedChange[]): string[] => {
  return [
    ...new Set(
      changes
        .filter((c) => c.table === 'chat_messages' && c.cid === 'chat_thread_id' && typeof c.val === 'string')
        .map((c) => c.val as string),
    ),
  ]
}
