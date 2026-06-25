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

describe('findLegacyDbFilename', () => {
  it('returns null when OPFS is unavailable (private browsing / unsupported runtime)', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => false,
      getStorageRoot: async () => {
        throw new Error('getStorageRoot should not be called when OPFS is unavailable')
      },
    })
    expect(result).toBeNull()
  })

  it('returns null when OPFS is available but neither legacy file exists', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot([]),
    })
    expect(result).toBeNull()
  })

  it('returns thunderbolt-sync.db when present (PowerSync-era filename)', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt-sync.db']),
    })
    expect(result).toBe('thunderbolt-sync.db')
  })

  it('falls back to thunderbolt.db when only the pre-PowerSync file exists', async () => {
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt.db']),
    })
    expect(result).toBe('thunderbolt.db')
  })

  it('prefers thunderbolt-sync.db over thunderbolt.db when both exist', async () => {
    // Probe order in legacyDbFilenames is the contract — the newer file
    // carries the more complete state.
    expect(legacyDbFilenames[0]).toBe('thunderbolt-sync.db')
    const result = await findLegacyDbFilename({
      isOpfsAvailable: async () => true,
      getStorageRoot: async () => makeRoot(['thunderbolt-sync.db', 'thunderbolt.db']),
    })
    expect(result).toBe('thunderbolt-sync.db')
  })

  it('re-throws non-NotFoundError DOMExceptions instead of swallowing them', async () => {
    const root = {
      getFileHandle: async () => {
        throw new DOMException('boom', 'SecurityError')
      },
    } as unknown as FileSystemDirectoryHandle
    expect(
      findLegacyDbFilename({
        isOpfsAvailable: async () => true,
        getStorageRoot: async () => root,
      }),
    ).rejects.toThrow('boom')
  })
})
