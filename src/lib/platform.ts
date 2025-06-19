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
  // extend as new backend capabilities are added
}

const DEFAULT_CAPABILITIES: Capabilities = { libsql: false }

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
  if (!isTauri()) return 'sqlocal'

  const { libsql } = await getCapabilities()
  return libsql ? 'libsql-tauri' : 'sqlocal'
}

/**
 * Determines the appropriate database path based on platform and OPFS availability
 * @param databaseType - The type of database being used
 * @param appDataDirPath - The application data directory path
 * @returns The database path to use
 */
export const getDatabasePath = async (databaseType: DatabaseType, appDataDirPath: string): Promise<string> => {
  if (databaseType !== 'sqlocal') {
    return `${appDataDirPath}/thunderbolt.db`
  }

  const opfsAvailable = await isOpfsAvailable()
  if (opfsAvailable) {
    return `${appDataDirPath}/thunderbolt.db`
  }

  console.warn('OPFS not available (likely private browsing), using in-memory database')
  return ':memory:'
}
