/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetDatabase } from '@/db/database'
import { appIndexedDbNames, forgetLocalDataSlots } from './local-data-owner'
import { deleteIndexedDbDatabase, isOpfsAvailable, isTauri, powerSyncDbFilename } from './platform'
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

  // A file another tab holds open cannot be removed yet, so remove everything else and fail once at the end.
  const failures: unknown[] = []
  for await (const [name] of root.entries()) {
    console.info(`[resetAppDirOpfs] Removing entry: ${name}`)
    try {
      await root.removeEntry(name, { recursive: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to remove OPFS entries')
  }

  if (!isTauri()) {
    console.info(`[resetAppDirOpfs] Recreating app directory: ${appDataDirPath}`)
    await root.getDirectoryHandle(appDataDirPath, { create: true })
  }
}

/**
 * Deletes every slot's database and attachment store (see `local-data-owner.ts`).
 * The IndexedDB databases go first, because every attachment store lives there and a file another tab
 * holds open makes the OPFS step fail.
 * With OPFS, IndexedDB holds only attachments and leftovers from installs that predate OPFS, so a
 * failed delete there is only logged. Then the OPFS root is emptied and, on the web, the app directory
 * is recreated.
 * Without OPFS a failed IndexedDB delete fails the reset: the default config keeps each slot's database
 * there (Safari and Tauri keep it in memory).
 * Forgetting the slots makes every other tab reload, which closes what they hold open.
 */
const resetAppDirNow = async (): Promise<void> => {
  // Must await for PowerSync to properly call disconnectAndClear()
  await resetDatabase()

  const indexedDbNames = await appIndexedDbNames()
  forgetLocalDataSlots()
  const hasOpfs = await isOpfsAvailable()

  // A database another tab holds open finishes deleting when that tab closes (see `deleteIndexedDbDatabase`).
  const deletes = await Promise.allSettled(
    indexedDbNames.map((name) => withTimeout(deleteIndexedDbDatabase(name), 10_000, 'deleteIndexedDbDatabase')),
  )
  const errors = deletes.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length > 0 && !hasOpfs) {
    // The slots are forgotten, so nothing reopens these; a later wipe lists and retries them.
    throw new AggregateError(errors, 'Failed to delete the IndexedDB databases')
  }
  if (errors.length > 0) {
    // Cleanup only: a later OPFS start retries it (see `PowerSyncDatabaseImpl.initialize`).
    console.error('[resetAppDir] Failed to delete IndexedDB databases:', errors)
  }
  if (!hasOpfs) {
    return
  }

  await resetAppDirOpfs()
  // The data is wiped, so the next start can move to OPFS. An empty OPFS database file tells it
  // to, even while another tab keeps the IndexedDB database open and its delete pending.
  const root = await navigator.storage.getDirectory()
  await root.getFileHandle(powerSyncDbFilename, { create: true })
}

/** Report a stuck reset without releasing its ownership of files that are still closing or being removed. */
export const resetAppDir = (): Promise<void> =>
  withDeadline(runAppStorageOperation(resetAppDirNow), 30_000, () => new Error('Timed out clearing app storage'))
