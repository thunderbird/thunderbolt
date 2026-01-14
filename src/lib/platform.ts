import { invoke, isTauri as isTauriCore } from '@tauri-apps/api/core'
import { platform, type Platform } from '@tauri-apps/plugin-os'
import type { DatabaseType } from '../db/singleton'
import { memoize } from './memoize'

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
 * Determines the appropriate database type based on the platform.
 *
 * We use cr-sqlite (crsqlite) on ALL platforms for consistent multi-device sync:
 * - cr-sqlite adds CRDT (Conflict-free Replicated Data Types) support to SQLite
 * - Uses IndexedDB for persistence (via IDBBatchAtomicVFS) on both web and Tauri
 * - Enables seamless sync between devices without merge conflicts
 *
 * Trade-offs of using IndexedDB in Tauri (vs native libsql):
 * - Storage is in WebView's data directory, not app's data directory
 * - Users can't easily backup/export the raw .db file
 * - Slightly harder to debug (can't open DB file directly in SQL tools)
 *
 * Benefits:
 * - Consistent sync support across web browsers and desktop apps
 * - Same codebase, no platform-specific database logic
 * - CRDT automatically resolves conflicts when syncing between devices
 */
export const getDatabaseType = async (): Promise<DatabaseType> => {
  // Always use cr-sqlite for CRDT-based multi-device sync on all platforms
  return 'crsqlite'
}

/**
 * Determines the appropriate database path based on platform and storage availability.
 *
 * For cr-sqlite (default): The path is used as the IndexedDB database name.
 * IndexedDB is available in all modern browsers and Tauri WebViews.
 *
 * @param databaseType - The type of database being used
 * @param appDataDirPath - The application data directory path
 * @returns The database path/name to use
 */
export const getDatabasePath = async (databaseType: DatabaseType, appDataDirPath: string): Promise<string> => {
  // For native databases (libsql-tauri, bun-sqlite), use file path directly
  if (databaseType === 'libsql-tauri' || databaseType === 'bun-sqlite') {
    return `${appDataDirPath}/thunderbolt.db`
  }

  // For crsqlite: path is used as IndexedDB database name
  // IndexedDB is generally always available (browsers + Tauri WebViews)
  if (databaseType === 'crsqlite') {
    return `${appDataDirPath}/thunderbolt.db`
  }

  // For wa-sqlite (legacy): check OPFS availability
  const opfsAvailable = await isOpfsAvailable()
  if (opfsAvailable) {
    return `${appDataDirPath}/thunderbolt.db`
  }

  console.warn('OPFS not available (likely private browsing), using in-memory database')
  return ':memory:'
}
