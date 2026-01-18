/**
 * Shared utilities for cr-sqlite database synchronization
 * Used by both WebSocket sync service and HTTP-based initial sync
 */

import { decodeBase64, encodeBase64 } from '@/lib/utils'
import type { CRSQLChange } from '@/db/crsqlite-worker'
import { DatabaseSingleton } from '@/db/singleton'

// ============================================================================
// Storage Keys
// ============================================================================

export const SYNC_VERSION_KEY = 'thunderbolt_sync_version'
export const SYNC_SERVER_VERSION_KEY = 'thunderbolt_server_version'
export const SITE_ID_KEY = 'thunderbolt_site_id'

// ============================================================================
// Types
// ============================================================================

/**
 * Serialized change format for network transport
 * Uses base64 for binary data (pk, site_id) and strings for bigints
 */
export type SerializedChange = {
  table: string
  pk: string // base64 encoded
  cid: string
  val: unknown
  col_version: string // bigint as string
  db_version: string // bigint as string
  site_id: string // base64 encoded
  cl: number
  seq: number
}

// ============================================================================
// Change Serialization
// ============================================================================

/**
 * Serialize a CRSQLChange for network transport
 */
export const serializeChange = (change: CRSQLChange): SerializedChange => ({
  table: change.table,
  pk: encodeBase64(change.pk),
  cid: change.cid,
  val: change.val,
  col_version: change.col_version.toString(),
  db_version: change.db_version.toString(),
  site_id: encodeBase64(change.site_id),
  cl: change.cl,
  seq: change.seq,
})

/**
 * Deserialize a network change to CRSQLChange
 */
export const deserializeChange = (serialized: SerializedChange): CRSQLChange => ({
  table: serialized.table,
  pk: decodeBase64(serialized.pk),
  cid: serialized.cid,
  val: serialized.val,
  col_version: BigInt(serialized.col_version),
  db_version: BigInt(serialized.db_version),
  site_id: decodeBase64(serialized.site_id),
  cl: serialized.cl,
  seq: serialized.seq,
})

// ============================================================================
// Local Storage Helpers
// ============================================================================

/**
 * Get the last synced local db version
 */
export const getLastSyncedVersion = (): bigint => {
  const stored = localStorage.getItem(SYNC_VERSION_KEY)
  return stored ? BigInt(stored) : 0n
}

/**
 * Set the last synced local db version
 */
export const setLastSyncedVersion = (version: bigint): void => {
  localStorage.setItem(SYNC_VERSION_KEY, version.toString())
}

/**
 * Get the last known server version
 */
export const getServerVersion = (): bigint => {
  const stored = localStorage.getItem(SYNC_SERVER_VERSION_KEY)
  return stored ? BigInt(stored) : 0n
}

/**
 * Set the last known server version
 */
export const setServerVersion = (version: bigint): void => {
  localStorage.setItem(SYNC_SERVER_VERSION_KEY, version.toString())
}

/**
 * Get or register site ID for this device
 */
export const getSiteId = async (): Promise<string> => {
  const storedSiteId = localStorage.getItem(SITE_ID_KEY)
  if (storedSiteId) {
    return storedSiteId
  }

  const db = DatabaseSingleton.instance.syncableDatabase
  const siteId = await db.getSiteId()
  localStorage.setItem(SITE_ID_KEY, siteId)
  return siteId
}
