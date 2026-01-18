/**
 * Sync module - all sync-related functionality for cr-sqlite synchronization
 */

// Core sync logic
export {
  applyPullChanges,
  applyRemoteChanges,
  extractChatThreadIds,
  handlePullResponse,
  handlePushSuccess,
  isPullVersionMismatch,
  isPushVersionMismatch,
  preparePull,
  preparePush,
  type PreparedPull,
  type PreparedPush,
  type PullResponse,
  type PushResponse,
  type SerializedChange,
} from './core'

// Sync utilities
export {
  deserializeChange,
  getLastSyncedVersion,
  getServerVersion,
  getSiteId,
  serializeChange,
  setLastSyncedVersion,
  setServerVersion,
  SITE_ID_KEY,
  SYNC_SERVER_VERSION_KEY,
  SYNC_VERSION_KEY,
} from './utils'

// Initial HTTP sync
export { performInitialSync, pullChangesHttp, pushChangesHttp } from './initial-sync'

// WebSocket sync service
export { getSyncService, initSyncService, SyncService, type SyncServiceOptions, type SyncStatus } from './service'

// React hook
export { useSyncService, type UseSyncServiceResult } from './use-sync-service'
