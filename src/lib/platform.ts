/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri as isTauriCore } from '@tauri-apps/api/core'
import { platform, type Platform } from '@tauri-apps/plugin-os'
import type { DatabaseType } from '../db/database'

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

/** True on any Tauri desktop build (macOS, Windows, Linux). Web returns false. */
export const isTauriDesktop = (): boolean => isTauri() && isDesktop()

/** True on the Tauri macOS build. Web (including Safari/mac) returns false. */
export const isMacDesktop = (): boolean => isTauri() && getPlatform() === 'macos'

/**
 * True on the Tauri Windows or Linux desktop build — the frameless platforms
 * whose native title bar is hidden, so the frontend paints its own window
 * controls (see `WindowControls`). macOS (overlaid traffic lights) and web
 * (native chrome) return false.
 */
export const isFramelessControlsPlatform = (): boolean => {
  if (!isTauri()) {
    return false
  }
  const p = getPlatform()
  return p === 'windows' || p === 'linux'
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

/** Phones and tablets: the Tauri mobile apps and iOS/Android browsers, including iPadOS posing as macOS. */
export const isTouchPlatform = (): boolean => isMobile() || isWebMobilePlatform()

/** Returns true when the web browser is running on a desktop OS (macOS, Windows, Linux). */
export const isWebDesktopPlatform = (): boolean => {
  const p = getWebOsPlatform()
  return p === 'macos' || p === 'windows' || p === 'linux'
}

/**
 * Returns true when running on iOS — whether the Tauri iOS app (WKWebView) or a
 * web browser on iOS/iPadOS. Combines the Tauri-native and web-UA detection
 * paths, which no single existing predicate covers on its own.
 */
export const isIosPlatform = (): boolean => (isTauri() && getPlatform() === 'ios') || getWebOsPlatform() === 'ios'

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

    // Concurrent tabs can probe in the same millisecond. Each must remove only
    // its own file, or one reports unavailable storage and opens an empty DB.
    const testFileName = `opfs-test-${crypto.randomUUID()}.txt`
    await root.getFileHandle(testFileName, { create: true })

    // Clean up test file
    await root.removeEntry(testFileName)

    return true
  } catch (error) {
    console.warn('OPFS is not available:', error)
    return false
  }
}

/**
 * Whether an IndexedDB database with this name exists. Browsers without `indexedDB.databases()`
 * (Firefox before 126) count as yes, so they keep their data.
 */
export const hasIndexedDbDatabase = async (
  name: string,
  idb: Pick<IDBFactory, 'databases'> = indexedDB,
): Promise<boolean> => {
  if (typeof idb.databases !== 'function') {
    return true
  }
  const databases = await idb.databases()
  return databases.some((database) => database.name === name)
}

/** Whether the OPFS root holds a file with this name. */
export const hasOpfsFile = async (
  name: string,
  root?: Pick<FileSystemDirectoryHandle, 'getFileHandle'>,
): Promise<boolean> => {
  const directory = root ?? (await navigator.storage.getDirectory())
  try {
    await directory.getFileHandle(name)
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return false
    }
    throw error
  }
}

/**
 * Deletes an IndexedDB database. Resolves early if another tab holds it open; the browser
 * finishes the delete once that tab closes.
 */
export const deleteIndexedDbDatabase = (name: string, idb: Pick<IDBFactory, 'deleteDatabase'> = indexedDB) =>
  new Promise<void>((resolve, reject) => {
    const request = idb.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onblocked = () => resolve()
    request.onerror = () => reject(request.error)
  })

/**
 * Checks whether IndexedDB is available and openable.
 * iOS Lockdown Mode ("Configure Web Browsing") and some private/enterprise
 * configs leave the `indexedDB` global present but make open() throw or error,
 * so we attempt an actual open rather than a type check.
 * @param idb - injectable factory for testing; defaults to the global.
 */
export const isIndexedDbAvailable = async (idb?: IDBFactory | null): Promise<boolean> => {
  const probeName = 'thunderbolt-idb-probe'
  try {
    // Resolve the factory inside the try: in hardened environments even reading
    // the `indexedDB` global (not just calling open()) can throw. A no-arg call
    // falls back to the global; an explicit null factory is treated as missing.
    const factory = idb === undefined ? globalThis.indexedDB : idb
    if (!factory) {
      return false
    }
    return await new Promise<boolean>((resolve) => {
      // A probe that never settles would reintroduce the boot hang this check
      // exists to prevent, so fall back to "unavailable" after a short timeout.
      // Generous enough to avoid a false negative on a slow first open.
      const timeout = setTimeout(() => resolve(false), 5000)
      const settle = (available: boolean) => {
        clearTimeout(timeout)
        resolve(available)
      }
      const request = factory.open(probeName)
      // Opening a fresh probe db triggers a version-change upgrade; we only
      // care that the open succeeds, so the upgrade itself is a no-op.
      request.onupgradeneeded = () => {}
      request.onsuccess = () => {
        request.result.close()
        factory.deleteDatabase(probeName)
        settle(true)
      }
      request.onerror = () => settle(false)
      request.onblocked = () => settle(false)
    })
  } catch (error) {
    console.warn('IndexedDB is not available:', error)
    return false
  }
}

/** Return the app database implementation. */
export const getDatabaseType = async (): Promise<DatabaseType> => {
  return 'powersync'
}

/** The PowerSync database's filename: the OPFS file, or the IndexedDB database name. */
export const powerSyncDbFilename = 'thunderbolt-sync.db'

/**
 * Determines the PowerSync database path from OPFS availability
 * @param appDataDirPath - The application data directory path
 * @returns The database path to use, or `':memory:'` when OPFS is unavailable
 */
export const getDatabasePath = async (appDataDirPath: string): Promise<string> => {
  const opfsAvailable = await isOpfsAvailable()
  if (opfsAvailable) {
    return `${appDataDirPath}/${powerSyncDbFilename}`
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
