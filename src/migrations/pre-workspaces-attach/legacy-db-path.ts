/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isOpfsAvailable as defaultIsOpfsAvailable } from '@/lib/platform'

/**
 * Legacy SQLite filenames the pre-workspaces builds wrote to:
 *
 *   - `thunderbolt-sync.db` — the PowerSync-era wa-sqlite file (last used by
 *     the build immediately preceding Workspaces v1).
 *   - `thunderbolt.db` — the pre-PowerSync wa-sqlite filename. Some long-time
 *     users still have this file from before the PowerSync migration.
 *
 * Probed in order; the first hit wins. `thunderbolt-sync.db` is checked first
 * because it's the more recent file — if both exist, the newer one carries the
 * more complete state.
 */
export const legacyDbFilenames = ['thunderbolt-sync.db', 'thunderbolt.db'] as const

export type LegacyDbFilename = (typeof legacyDbFilenames)[number]

const fileExistsInOpfs = async (root: FileSystemDirectoryHandle, name: string): Promise<boolean> => {
  try {
    await root.getFileHandle(name)
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return false
    }
    throw err
  }
}

export type LegacyDbProbeDeps = {
  isOpfsAvailable?: () => Promise<boolean>
  getStorageRoot?: () => Promise<FileSystemDirectoryHandle>
}

/**
 * Returns the filename of the legacy SQLite file present on disk, or `null`
 * when none exists. Looks only at OPFS — both wa-sqlite VFS variants (OPFS and
 * Tauri's OPFSCoopSyncVFS) store the SQLite file at the OPFS root, and private
 * browsing (no OPFS) means the legacy build was running on `:memory:` so
 * there's nothing to migrate.
 *
 * Deps are exposed for tests (happy-dom doesn't implement OPFS). Production
 * callers leave them defaulted.
 */
export const findLegacyDbFilename = async ({
  isOpfsAvailable = defaultIsOpfsAvailable,
  getStorageRoot = () => navigator.storage.getDirectory(),
}: LegacyDbProbeDeps = {}): Promise<LegacyDbFilename | null> => {
  if (!(await isOpfsAvailable())) {
    return null
  }
  const root = await getStorageRoot()
  for (const name of legacyDbFilenames) {
    if (await fileExistsInOpfs(root, name)) {
      return name
    }
  }
  return null
}
