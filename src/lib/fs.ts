/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetDatabase } from '@/db/database'
import { deleteIndexedDbDatabase, getDatabasePath, isOpfsAvailable, isTauri, powerSyncDbFilename } from './platform'
import { withTimeout } from './timeout'

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
 * Resets app data directory in web environment using OPFS
 */
const resetAppDirOpfs = async (): Promise<void> => {
  if (!(await isOpfsAvailable())) {
    throw new Error('OPFS is not available')
  }

  const appDataDirPath = await createAppDir()

  console.info('[resetAppDirOpfs] Getting OPFS root directory')
  const root: any = await navigator.storage.getDirectory()

  for await (const [name] of root.entries()) {
    console.info(`[resetAppDirOpfs] Removing entry: ${name}`)
    await root.removeEntry(name, { recursive: true })
  }

  if (!isTauri()) {
    console.info(`[resetAppDirOpfs] Recreating app directory: ${appDataDirPath}`)
    await root.getDirectoryHandle(appDataDirPath, { create: true })
  }
}

/**
 * Resets the data directory by deleting the database file and recreating the directory
 */
export const resetAppDir = async (): Promise<void> => {
  // Must await for PowerSync to properly call disconnectAndClear()
  await withTimeout(resetDatabase(), 10_000, 'DatabaseSingleton.reset')

  const appDataDirPath = await createAppDir()
  const dbPath = await getDatabasePath(appDataDirPath)

  // Only delete file if it's not an in-memory database
  if (dbPath === ':memory:') {
    return
  }

  await withTimeout(resetAppDirOpfs(), 10_000, 'resetAppDirOpfs')

  // The data is wiped, so the next start can move to OPFS. An empty OPFS database file tells it
  // to, even while another tab keeps the IndexedDB database open and its delete pending.
  const root = await navigator.storage.getDirectory()
  await root.getFileHandle(powerSyncDbFilename, { create: true })
  // Cleanup only: a later OPFS start retries it (see `PowerSyncDatabaseImpl.initialize`).
  try {
    await withTimeout(deleteIndexedDbDatabase(powerSyncDbFilename), 10_000, 'deleteIndexedDbDatabase')
  } catch (error) {
    console.error('[resetAppDir] Failed to delete the IndexedDB database:', error)
  }
}
