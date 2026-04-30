/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useConfigStore } from '@/api/config-store'

// Other test files mock the @/db/encryption barrel with isEncryptionEnabled: () => true.
// Bun's mock.module leaks across files and replaces the underlying config module too.
// Re-provide the real implementation here so these tests exercise actual config store logic.
// Use ...spread to preserve exports like encryptedColumnsMap that other tests depend on.
const realConfig = await import('./config')
mock.module('@/db/encryption/config', () => ({
  ...realConfig,
  isEncryptionEnabled: () => useConfigStore.getState().config.e2eeEnabled === true,
  needsSyncSetupWizard: async () => false,
}))

const realEncryption = await import('@/db/encryption')
mock.module('@/db/encryption', () => ({
  ...realEncryption,
  isEncryptionEnabled: () => useConfigStore.getState().config.e2eeEnabled === true,
  needsSyncSetupWizard: async () => false,
}))

import { isEncryptionEnabled } from './config'

describe('encryption config', () => {
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
})
