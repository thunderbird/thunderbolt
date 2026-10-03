/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { clearAllKeys, generateAK, storeAK, storeDEK } from '@/crypto'

// Re-provide the real config module to override leaked mocks from other test
// files (bun's mock.module leaks across files; some files stub
// needsSyncSetupWizard on this module).
const realConfig = await import('./config')
mock.module('@/db/encryption/config', () => ({ ...realConfig }))

const { needsSyncSetupWizard } = realConfig

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

describe('encryption config', () => {
  beforeEach(async () => {
    await deleteDatabase()
    // clearAllKeys empties whichever key-storage backend is bound — the real
    // fake-indexeddb one, or the Map-backed mock leaked from services tests
    // (deleteDatabase alone does not clear those Maps).
    await clearAllKeys()
  })

  describe('needsSyncSetupWizard', () => {
    it('returns true when the AK is missing', async () => {
      await storeDEK('0', 'wrapped-blob')
      expect(await needsSyncSetupWizard()).toBe(true)
    })

    it('returns true when the AK exists but no wrapped DEK is staged', async () => {
      await storeAK(await generateAK())
      expect(await needsSyncSetupWizard()).toBe(true)
    })

    it('returns false when both the AK and at least one wrapped DEK exist', async () => {
      await storeAK(await generateAK())
      await storeDEK('0', 'wrapped-blob')
      expect(await needsSyncSetupWizard()).toBe(false)
    })
  })
})
