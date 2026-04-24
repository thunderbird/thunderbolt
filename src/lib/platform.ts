import { invoke, isTauri as isTauriCore } from '@tauri-apps/api/core'
import { platform, type Platform } from '@tauri-apps/plugin-os'
import type { DatabaseType } from '../db/database'
import type { AgentType } from '@/acp/types'
import { memoize } from './memoize'

/** Matches Render PR preview hostnames: thunderbolt-pr-{number}.onrender.com */
export const prPreviewHostRegex = /^thunderbolt-pr-\d+\.onrender\.com$/

/**
 * Returns true when the frontend is running on a Render PR preview deployment
 * (e.g. https://thunderbolt-pr-368.onrender.com/).
 */
export const isPrPreview = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  return prPreviewHostRegex.test(window.location.hostname)
}

/**
 * Detects if the app is running in a Tauri environment
 * @returns true if running in Tauri, false otherwise
 */
export const isTauri = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  return 'isTauri' in window && isTauriCore()
}

/**
 * Get the current platform
 * @returns The platform string: 'linux', 'macos', 'ios', 'android', 'windows', etc.
 */
export const getPlatform = (): 'web' | Platform => {
  if (typeof window === 'undefined') {
    return 'web'
  }
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

export type WebOsPlatform = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown'

/**
 * Detects the user's OS when running in a web browser via navigator.userAgent.
 * @returns The web OS platform, or 'unknown' when running in Tauri or when the UA cannot be parsed.
 */
export const getWebOsPlatform = (): WebOsPlatform => {
  if (isTauri() || typeof navigator === 'undefined') {
    return 'unknown'
  }
  const ua = navigator.userAgent
  // Check mobile platforms first — their UAs also contain desktop OS strings
  if (/iPhone|iPad/.test(ua)) {
    return 'ios'
  }
  if (/Android/.test(ua)) {
    return 'android'
  }
  if (/Mac/.test(ua)) {
    // iPadOS 13+ reports a desktop "Macintosh" UA — distinguish via touch support
    if (navigator.maxTouchPoints > 0) {
      return 'ios'
    }
    return 'macos'
  }
  if (/Win/.test(ua)) {
    return 'windows'
  }
  if (/Linux/.test(ua)) {
    return 'linux'
  }
  return 'unknown'
}

/** Returns true when the web browser is running on a mobile OS (iOS or Android). */
export const isWebMobilePlatform = (): boolean => {
  const p = getWebOsPlatform()
  return p === 'ios' || p === 'android'
}

/** Returns true when the web browser is running on a desktop OS (macOS, Windows, Linux). */
export const isWebDesktopPlatform = (): boolean => {
  const p = getWebOsPlatform()
  return p === 'macos' || p === 'windows' || p === 'linux'
}

/**
 * Checks if an agent type can run on the current platform.
 * Local agents require Tauri desktop; built-in and remote agents work everywhere.
 */
export const isAgentAvailableOnPlatform = (agentType: AgentType): boolean => {
  if (agentType === 'local') {
    return isTauri() && isDesktop()
  }
  return true
}

type WebBrowser = 'safari' | 'chrome' | 'firefox' | 'edge' | 'unknown'

/**
 * Returns the browser when running on web (not Tauri).
 * Chrome and Edge include "Safari" in their UA for compatibility, so we check Edge/Chrome first.
 * @returns Browser identifier, or 'unknown' when not on web or UA cannot be parsed
 */
export const getWebBrowser = (): WebBrowser => {
  if (getPlatform() !== 'web' || typeof navigator === 'undefined') {
    return 'unknown'
  }

  const ua = navigator.userAgent

  if (ua.includes('Edg')) {
    return 'edge'
  }
  if (ua.includes('Chrome')) {
    return 'chrome'
  }
  if (ua.includes('Firefox')) {
    return 'firefox'
  }
  if (ua.includes('Safari')) {
    return 'safari'
  }

  return 'unknown'
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

export type Capabilities = {
  native_fetch: boolean
}

const defaultCapabilities: Capabilities = { native_fetch: false }

// Fetch once, then memoize for the rest of the session.
const fetchCapabilities = memoize(async (): Promise<Capabilities> => {
  if (!isTauri()) {
    return defaultCapabilities
  }

  try {
    return await invoke<Capabilities>('capabilities')
  } catch (err) {
    console.error('Failed to retrieve capabilities:', err)
    return defaultCapabilities
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
  // For native databases (bun-sqlite), use file path directly
  if (databaseType === 'bun-sqlite') {
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
const platformDisplayNames: Record<string, string> = {
  ios: 'iOS',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
}

const formatPlatformName = (p: string): string => platformDisplayNames[p] ?? p.charAt(0).toUpperCase() + p.slice(1)

export const getDeviceDisplayName = (): string => {
  if (isTauri()) {
    return `Thunderbolt on ${formatPlatformName(getPlatform())}`
  }
  const browser = getWebBrowser()
  const browserDisplay = browser === 'unknown' ? 'Browser' : browser.charAt(0).toUpperCase() + browser.slice(1)
  const os = formatPlatformName(getWebOsPlatform())
  return `${browserDisplay} on ${os}`
}
