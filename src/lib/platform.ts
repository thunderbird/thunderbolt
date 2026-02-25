import { invoke, isTauri as isTauriCore } from '@tauri-apps/api/core'
import { platform, type Platform } from '@tauri-apps/plugin-os'
import type { DatabaseType } from '../db/singleton'
import { memoize } from './memoize'

/** Matches Render PR preview hostnames: thunderbolt-pr-{number}.onrender.com */
export const prPreviewHostRegex = /^thunderbolt-pr-\d+\.onrender\.com$/

/**
 * Returns true when the frontend is running on a Render PR preview deployment
 * (e.g. https://thunderbolt-pr-368.onrender.com/).
 */
export const isPrPreview = (): boolean => {
  if (typeof window === 'undefined') return false
  return prPreviewHostRegex.test(window.location.hostname)
}

/**
 * Detects if the app is running in a Tauri environment
 * @returns true if running in Tauri, false otherwise
 */
export const isTauri = (): boolean => {
  return 'isTauri' in window && isTauriCore()
}

/**
 * Get the current platform
 * @returns The platform string: 'linux', 'macos', 'ios', 'android', 'windows', etc.
 */
export const getPlatform = (): 'web' | Platform => {
  return 'isTauri' in window ? platform() : 'web'
}

/**
 * Detects if the app is running on a desktop platform
 * @returns true if running on desktop (macOS, Windows, Linux), false otherwise
 */
export const isDesktop = (): boolean => {
  const currentPlatform = getPlatform()
  return ['linux', 'macos', 'windows', 'freebsd', 'dragonfly', 'netbsd', 'openbsd', 'solaris'].includes(currentPlatform)
}

/**
 * Detects if the app is running on a mobile platform
 * @returns true if running on mobile (iOS or Android), false otherwise
 */
export const isMobile = (): boolean => {
  const currentPlatform = getPlatform()
  return currentPlatform === 'ios' || currentPlatform === 'android'
}

/**
 * Checks if OPFS (Origin Private File System) is available
 * OPFS is not available in private/incognito browsing modes
 * @returns Promise<boolean> - true if OPFS is available, false otherwise
 */
export const isOpfsAvailable = async (): Promise<boolean> => {
  try {
    // Check if the browser supports the necessary APIs
    if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
      return false
    }

    // Try to access OPFS - this will fail in private browsing
    const root = await navigator.storage.getDirectory()

    // Try to create a test file to ensure write access
    const testFileName = `opfs-test-${Date.now()}.txt`
    await root.getFileHandle(testFileName, { create: true })

    // Clean up test file
    await root.removeEntry(testFileName)

    return true
  } catch (error) {
    console.warn('OPFS is not available:', error)
    return false
  }
}

// -----------------------------------------------------------------------------
// Capabilities
// -----------------------------------------------------------------------------

export interface Capabilities {
  libsql: boolean
  native_fetch: boolean
  // extend as new backend capabilities are added
}

const DEFAULT_CAPABILITIES: Capabilities = { libsql: false, native_fetch: false }

// Fetch once, then memoize for the rest of the session.
const fetchCapabilities = memoize(async (): Promise<Capabilities> => {
  if (!isTauri()) return DEFAULT_CAPABILITIES

  try {
    return await invoke<Capabilities>('capabilities')
  } catch (err) {
    console.error('Failed to retrieve capabilities:', err)
    return DEFAULT_CAPABILITIES
  }
}, 'capabilities')

export const getCapabilities = (): Promise<Capabilities> => fetchCapabilities()

/**
 * Determines the appropriate database type based on the platform and the
 * capabilities exposed by the backend.
 *
 * Note: this is asynchronous because we might need to query the backend once.
 */
export const getDatabaseType = async (): Promise<DatabaseType> => {
  return 'powersync'
}

/**
 * Determines the appropriate database path based on platform and OPFS availability
 * @param databaseType - The type of database being used
 * @param appDataDirPath - The application data directory path
 * @returns The database path to use
 */
export const getDatabasePath = async (databaseType: DatabaseType, appDataDirPath: string): Promise<string> => {
  // For native databases (libsql-tauri, bun-sqlite), use file path directly
  if (databaseType === 'libsql-tauri' || databaseType === 'bun-sqlite') {
    return `${appDataDirPath}/thunderbolt.db`
  }

  // For wa-sqlite and powersync, check OPFS availability
  const opfsAvailable = await isOpfsAvailable()
  if (opfsAvailable) {
    // Use different filename for PowerSync to avoid conflicts during migration
    const filename = databaseType === 'powersync' ? 'thunderbolt-sync.db' : 'thunderbolt.db'
    return `${appDataDirPath}/${filename}`
  }

  console.warn('OPFS not available (likely private browsing), using in-memory database')
  return ':memory:'
}

/**
 * Returns an auto-filled device display name (e.g. "Chrome on macOS", "Safari on iOS").
 * Used for the synced devices table; not editable by the user.
 */
export const getDeviceDisplayName = (): string => {
  if (isTauri()) {
    const p = getPlatform()
    const name = p.charAt(0).toUpperCase() + p.slice(1)
    return `Thunderbolt on ${name}`
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let browser = 'Browser'
  if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome'
  else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari'
  else if (ua.includes('Firefox')) browser = 'Firefox'
  else if (ua.includes('Edg')) browser = 'Edge'
  let os = 'Unknown'
  if (ua.includes('Mac')) os = 'macOS'
  else if (ua.includes('Win')) os = 'Windows'
  else if (ua.includes('Linux')) os = 'Linux'
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS'
  else if (ua.includes('Android')) os = 'Android'
  return `${browser} on ${os}`
}
