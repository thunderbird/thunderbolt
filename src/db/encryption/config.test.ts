/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { clearAllKeys, generateAK, storeAK, storeDEK } from '@/crypto'

// Re-provide the real config module to override leaked mocks from other test
// files (bun's mock.module leaks across files; some files stub
// needsSyncSetupWizard/isEncryptionEnabled on this module).
const realConfig = await import('./config')
mock.module('@/db/encryption/config', () => ({ ...realConfig }))

const { isEncryptionEnabled, needsSyncSetupWizard } = realConfig

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

describe('encryption config', () => {
  // Reset on both sides: another file's fetchConfig test may leave `e2eeEnabled`
  // set in the shared persisted store, so isolate before reading too.
  beforeEach(async () => {
    await deleteDatabase()
    // clearAllKeys empties whichever key-storage backend is bound — the real
    // fake-indexeddb one, or the Map-backed mock leaked from services tests
    // (deleteDatabase alone does not clear those Maps).
    await clearAllKeys()
    useConfigStore.setState({ config: {} })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  describe('isEncryptionEnabled', () => {
    it('returns false when config store has no e2eeEnabled value', () => {
      expect(isEncryptionEnabled()).toBe(false)
    })

    it('returns false when e2eeEnabled is false', () => {
      useConfigStore.getState().updateConfig({ e2eeEnabled: false })
      expect(isEncryptionEnabled()).toBe(false)
    })

    it('returns true when e2eeEnabled is true', () => {
      useConfigStore.getState().updateConfig({ e2eeEnabled: true })
      expect(isEncryptionEnabled()).toBe(true)
    })
  })

  describe('needsSyncSetupWizard', () => {
    it('returns false when encryption is disabled, regardless of key state', async () => {
      expect(await needsSyncSetupWizard()).toBe(false)
    })

    it('returns true when the AK is missing', async () => {
      useConfigStore.getState().updateConfig({ e2eeEnabled: true })
      await storeDEK('0', 'wrapped-blob')
      expect(await needsSyncSetupWizard()).toBe(true)
    })

    it('returns true when the AK exists but no wrapped DEK is staged', async () => {
      useConfigStore.getState().updateConfig({ e2eeEnabled: true })
      await storeAK(await generateAK())
      expect(await needsSyncSetupWizard()).toBe(true)
    })

    it('returns false when both the AK and at least one wrapped DEK exist', async () => {
      useConfigStore.getState().updateConfig({ e2eeEnabled: true })
      await storeAK(await generateAK())
      await storeDEK('0', 'wrapped-blob')
      expect(await needsSyncSetupWizard()).toBe(false)
    })
  })
})
