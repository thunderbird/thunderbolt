import { DatabaseSingleton } from '@/db/singleton'
import { getDatabasePath, getDatabaseType, isOpfsAvailable, isTauri } from './platform'

// Only import Tauri APIs when in Tauri environment
let tauriPath: any = null
let tauriFs: any = null

// Lazy load Tauri modules only when needed
const loadTauriModules = async () => {
  if (isTauri() && !tauriPath) {
    try {
      tauriPath = await import('@tauri-apps/api/path')
      tauriFs = await import('@tauri-apps/plugin-fs')
    } catch (error) {
      console.error('Failed to load Tauri modules:', error)
    }
  }
}

/**
 * Creates app data directory in Tauri environment using file system
 */
const createAppDirTauri = async (): Promise<string> => {
  await loadTauriModules()

  if (!tauriPath || !tauriFs) {
    throw new Error('Failed to load Tauri filesystem modules')
  }

  const appDataDirPath = await tauriPath.appDataDir()

  await tauriFs.mkdir('data', { recursive: true, baseDir: tauriPath.BaseDirectory.AppData })
  console.info('App data directory initialized:', appDataDirPath)

  return appDataDirPath
}

/**
 * Creates app data directory in web environment using virtual path for OPFS
 */
const createAppDirOpfs = async (): Promise<string> => {
  const virtualPath = 'app-data'
  console.info('Web environment - using virtual app data path:', virtualPath)
  return virtualPath
}

/**
 * Creates app data directory, branching based on platform
 */
export const createAppDir = async (): Promise<string> => {
  if (isTauri()) {
    return await createAppDirTauri()
  }
  return await createAppDirOpfs()
}

/**
 * Resets app data directory in Tauri environment by deleting and recreating
 */
const resetAppDirTauri = async (): Promise<void> => {
  const appDataDirPath = await createAppDirTauri()
  const { remove } = await import('@tauri-apps/plugin-fs')
  await remove(appDataDirPath, { recursive: true })
}

const opfsResetTimeoutMs = 8_000

/**
 * Resets app data directory in web environment using OPFS.
 *
 * Wrapped in a timeout because OPFS operations (getDirectory, entries, removeEntry)
 * can hang indefinitely on some platforms — notably Tauri iOS WKWebView, where
 * the File System Access API behaves unreliably. If we hang, the reset never
 * completes and the finally block (localStorage.clear + reload) never runs,
 * leaving the app in a broken state. The timeout ensures we bail and the caller
 * can still run its finally block.
 */
const resetAppDirOpfs = async (): Promise<void> => {
  const reset = async (): Promise<void> => {
    if (!(await isOpfsAvailable())) {
      throw new Error('OPFS is not available')
    }

    const appDataDirPath = await createAppDir()
    const root: any = await navigator.storage.getDirectory()

    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true })
    }

    if (!isTauri()) {
      await root.getDirectoryHandle(appDataDirPath, { create: true })
    }
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`OPFS reset timed out after ${opfsResetTimeoutMs}ms`)), opfsResetTimeoutMs)
  })

  await Promise.race([reset(), timeoutPromise])
}

/**
 * Resets the data directory by deleting the database file and recreating the directory
 */
export const resetAppDir = async (): Promise<void> => {
  // Must await for PowerSync to properly call disconnectAndClear()
  await DatabaseSingleton.reset()

  const appDataDirPath = await createAppDir()
  const databaseType = await getDatabaseType()
  const dbPath = await getDatabasePath(databaseType, appDataDirPath)

  // Only delete file if it's not an in-memory database
  if (dbPath === ':memory:') {
    return
  }

  if (databaseType === 'libsql-tauri') {
    await resetAppDirTauri()
  } else if (databaseType === 'wa-sqlite' || databaseType === 'powersync') {
    // Both wa-sqlite and PowerSync use OPFS
    await resetAppDirOpfs()
  } else {
    throw new Error(`Unsupported database type: ${databaseType}`)
  }
}
