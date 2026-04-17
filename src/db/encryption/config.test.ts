import { afterEach, describe, expect, it, mock } from 'bun:test'
import { resetConfigStore, useConfigStore } from '@/api/config-store'

// Other test files mock the @/db/encryption barrel with isEncryptionEnabled: () => true.
// Bun's mock.module leaks across files and replaces the underlying config module too.
// Re-provide the real implementation here so these tests exercise actual config store logic.
mock.module('@/db/encryption/config', () => ({
  isEncryptionEnabled: () => useConfigStore.getState().config.e2eeEnabled === true,
  needsSyncSetupWizard: async () => false,
  encryptedColumnsMap: {},
}))

mock.module('@/db/encryption', () => ({
  isEncryptionEnabled: () => useConfigStore.getState().config.e2eeEnabled === true,
  needsSyncSetupWizard: async () => false,
  encryptedColumnsMap: {},
}))

import { isEncryptionEnabled } from './config'

describe('encryption config', () => {
  afterEach(() => {
    resetConfigStore()
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
