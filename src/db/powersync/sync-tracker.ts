import { getPlatform } from '@/lib/platform'
import { type EventType, trackEvent } from '@/lib/posthog'
import type { PowerSyncDatabase, SyncStatus } from '@powersync/web'
import type { PowerSyncDatabaseConfig } from './database'

type SyncEventType = Extract<EventType, `sync_${string}`>

const maxErrorLength = 200

/**
 * Sanitize error strings for analytics — truncate to avoid leaking verbose backend responses.
 */
export const sanitizeErrorForTracking = (error: unknown): string => {
  const str = String(error)
  return str.length > maxErrorLength ? `${str.slice(0, maxErrorLength)}…` : str
}

/** Timestamp when sync was first connected this session */
let connectedSince: number | null = null

/** Timestamp of last download activity (updated on statusChanged when downloading) */
let lastDownloadAt: number | null = null

/** Previous connected state for transition detection */
let prevConnected: boolean | null = null

/** Timestamp of last status change event */
let lastStatusChangeAt: number | null = null

/** Unsubscribe function for status listener */
let unsubscribeStatus: (() => void) | null = null

/** Cached config for context */
let cachedConfig: PowerSyncDatabaseConfig | null = null

/** Cached PowerSync instance for context */
let cachedPowerSync: PowerSyncDatabase | null = null

const getSyncEventContext = (): Record<string, unknown> => {
  const status = cachedPowerSync?.currentStatus
  return {
    platform: getPlatform(),
    ps_config: cachedConfig ?? 'unknown',
    ps_connected: status?.connected ?? false,
    ps_connecting: status?.connecting ?? false,
    ps_has_synced: status?.hasSynced ?? false,
    ps_last_synced_at: status?.lastSyncedAt ? new Date(status.lastSyncedAt).toISOString() : null,
    ps_uploading: status?.dataFlowStatus?.uploading ?? false,
    ps_downloading: status?.dataFlowStatus?.downloading ?? false,
    uptime_ms: connectedSince ? Date.now() - connectedSince : 0,
  }
}

/**
 * Track a sync diagnostic event with shared context properties.
 * Safe to call even if PostHog isn't initialized yet (silently no-ops).
 */
export const trackSyncEvent = (eventName: SyncEventType, extraProps?: Record<string, unknown>) => {
  trackEvent(eventName, { ...getSyncEventContext(), ...extraProps })
}

/**
 * Get the time since last download activity in milliseconds, or null if no download recorded.
 */
export const getMsSinceLastDownload = (): number | null => {
  if (!lastDownloadAt) {
    return null
  }
  return Date.now() - lastDownloadAt
}

/**
 * Start listening to PowerSync status changes for diagnostic tracking.
 * Only fires events on connected↔disconnected transitions.
 */
export const startSyncStatusListener = (powerSync: PowerSyncDatabase, config: PowerSyncDatabaseConfig) => {
  stopSyncStatusListener()

  cachedPowerSync = powerSync
  cachedConfig = config
  connectedSince = Date.now()
  lastDownloadAt = Date.now()
  prevConnected = powerSync.currentStatus?.connected ?? false
  lastStatusChangeAt = Date.now()

  unsubscribeStatus = powerSync.registerListener({
    statusChanged: (status: SyncStatus) => {
      const now = Date.now()
      const currentConnected = status.connected

      // Track download activity timestamps
      if (status.dataFlowStatus?.downloading) {
        lastDownloadAt = now
      }

      // Only fire sync_status_change on connected↔disconnected transitions
      if (prevConnected !== null && currentConnected !== prevConnected) {
        trackSyncEvent('sync_status_change', {
          prev_connected: prevConnected,
          ms_since_last_change: lastStatusChangeAt ? now - lastStatusChangeAt : 0,
        })
        lastStatusChangeAt = now
      }

      prevConnected = currentConnected
    },
  })
}

/**
 * Stop the sync status listener and clean up state.
 */
export const stopSyncStatusListener = () => {
  unsubscribeStatus?.()
  unsubscribeStatus = null
  cachedPowerSync = null
  cachedConfig = null
  connectedSince = null
  lastDownloadAt = null
  prevConnected = null
  lastStatusChangeAt = null
}
