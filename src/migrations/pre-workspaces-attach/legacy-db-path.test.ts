/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { findLegacyDbFilename, legacyDbFilenames } from './legacy-db-path'

const makeRoot = (existingFiles: readonly string[]): FileSystemDirectoryHandle => {
  const set = new Set(existingFiles)
  return {
    getFileHandle: async (name: string) => {
      if (!set.has(name)) {
        throw new DOMException('not found', 'NotFoundError')
      }
      return { name } as unknown as FileSystemFileHandle
    },
  } as unknown as FileSystemDirectoryHandle
}

const idbWith = (existing: readonly string[]) => {
  const set = new Set(existing)
  return async (name: string) => set.has(name)
}

const idbAlwaysFalse = async (_name: string): Promise<boolean> => false

describe('findLegacyDbFilename', () => {
  it('returns null when OPFS is unavailable AND IDB has no matching DB (private browsing / clean install)', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => false,
      getStorageRoot: async () => {
        throw new Error('getStorageRoot should not be called when OPFS is unavailable')
      },
      idbDatabaseExists: idbAlwaysFalse,
    })
    expect(result).toBeNull()
  })

  it('returns null when neither OPFS nor IDB has a legacy file', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot([]),
      idbDatabaseExists: idbAlwaysFalse,
    })
    expect(result).toBeNull()
  })

  it('returns thunderbolt-sync.db in OPFS (Tauri / Safari path)', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt-sync.db']),
      idbDatabaseExists: idbAlwaysFalse,
    })
    expect(result).toEqual({ filename: 'thunderbolt-sync.db', backend: 'opfs' })
  })

  it('returns thunderbolt-sync.db in IDB (Chrome/Edge/Firefox web path)', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot([]), // OPFS empty
      idbDatabaseExists: idbWith(['thunderbolt-sync.db']),
    })
    expect(result).toEqual({ filename: 'thunderbolt-sync.db', backend: 'idb' })
  })

  it('still finds IDB-stored legacy DB when OPFS is unavailable (private browsing on a previously-IDB-VFS user)', async () => {
    // Defensive: if a user somehow ends up with OPFS unavailable today but
    // had legacy data via the IDB-VFS cohort, we shouldn't lose access to it.
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => false,
      getStorageRoot: async () => {
        throw new Error('getStorageRoot should not be called when OPFS is unavailable')
      },
      idbDatabaseExists: idbWith(['thunderbolt-sync.db']),
    })
    expect(result).toEqual({ filename: 'thunderbolt-sync.db', backend: 'idb' })
  })

  it('falls back to thunderbolt.db (pre-PowerSync filename) in either backend', async () => {
    const fromOpfs = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt.db']),
      idbDatabaseExists: idbAlwaysFalse,
    })
    expect(fromOpfs).toEqual({ filename: 'thunderbolt.db', backend: 'opfs' })

    const fromIdb = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot([]),
      idbDatabaseExists: idbWith(['thunderbolt.db']),
    })
    expect(fromIdb).toEqual({ filename: 'thunderbolt.db', backend: 'idb' })
  })

  it('prefers thunderbolt-sync.db over thunderbolt.db when both exist in the same backend', async () => {
    // Probe order in legacyDbFilenames is the contract — the newer file
    // carries the more complete state.
    expect(legacyDbFilenames[0]).toBe('thunderbolt-sync.db')
    const opfsBoth = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt-sync.db', 'thunderbolt.db']),
      idbDatabaseExists: idbAlwaysFalse,
    })
    expect(opfsBoth?.filename).toBe('thunderbolt-sync.db')

    const idbBoth = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot([]),
      idbDatabaseExists: idbWith(['thunderbolt-sync.db', 'thunderbolt.db']),
    })
    expect(idbBoth?.filename).toBe('thunderbolt-sync.db')
  })

  it('prefers OPFS over IDB when both backends have the file (Tauri/Safari path wins)', async () => {
    // If a user has migrated VFS at some point and both backends ended up
    // with a file, OPFS is the canonical one because that's the path the
    // current Tauri/Safari build's wa-sqlite would attach against.
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt-sync.db']),
      idbDatabaseExists: idbWith(['thunderbolt-sync.db']),
    })
    expect(result).toEqual({ filename: 'thunderbolt-sync.db', backend: 'opfs' })
  })

  it('re-throws non-NotFoundError DOMExceptions from OPFS instead of swallowing them', async () => {
    const root = {
      getFileHandle: async () => {
        throw new DOMException('boom', 'SecurityError')
      },
    } as unknown as FileSystemDirectoryHandle
    expect(
      findLegacyDbFilename({
        isOpfsAvailable: async () => true,
        getStorageRoot: async () => root,
        idbDatabaseExists: idbAlwaysFalse,
      }),
    ).rejects.toThrow('boom')
  })
})
