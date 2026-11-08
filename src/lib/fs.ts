/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetDatabase } from '@/db/database'
import { deleteIndexedDbDatabase, getDatabasePath, isOpfsAvailable, isTauri, powerSyncDbFilename } from './platform'
import { withDeadline, withTimeout } from './timeout'
import { createSerialQueue } from './serial-queue'

/** Boot and destructive reset share the same files and must never overlap. */
export const runAppStorageOperation = createSerialQueue()

/**
 * Creates app data directory in Tauri environment using file system
 */
const createAppDirTauri = async (): Promise<string> => {
  const [tauriPath, tauriFs] = await Promise.all([import('@tauri-apps/api/path'), import('@tauri-apps/plugin-fs')])

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
  const root = await navigator.storage.getDirectory()

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
const resetAppDirNow = async (): Promise<void> => {
  // Must await for PowerSync to properly call disconnectAndClear()
  await resetDatabase()

  const appDataDirPath = await createAppDir()
  const dbPath = await getDatabasePath(appDataDirPath)

  if (dbPath !== ':memory:') {
    await resetAppDirOpfs()

    // The data is wiped, so the next start can move to OPFS. An empty OPFS database file tells it
    // to, even while another tab keeps the IndexedDB database open and its delete pending.
    const root = await navigator.storage.getDirectory()
    await root.getFileHandle(powerSyncDbFilename, { create: true })
  }

  // Cleanup IndexedDB storage (and legacy ':memory:' IndexedDB store when OPFS is unavailable).
  const dbNamesToDelete = dbPath === ':memory:' ? [powerSyncDbFilename, ':memory:'] : [powerSyncDbFilename]
  for (const dbName of dbNamesToDelete) {
    try {
      await withTimeout(deleteIndexedDbDatabase(dbName), 10_000, 'deleteIndexedDbDatabase')
    } catch (error) {
      console.error('[resetAppDir] Failed to delete the IndexedDB database:', error)
    }
  }
}

/** Report a stuck reset without releasing its ownership of files that are still closing or being removed. */
export const resetAppDir = (): Promise<void> =>
  withDeadline(runAppStorageOperation(resetAppDirNow), 30_000, () => new Error('Timed out clearing app storage'))
