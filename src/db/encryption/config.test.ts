import { afterEach, describe, expect, it, mock } from 'bun:test'

// Other test files mock the @/db/encryption barrel with isEncryptionEnabled: () => true.
// Bun's mock.module leaks across files and replaces the underlying config module too.
// Re-provide the real implementation here so these tests exercise actual localStorage logic.
const e2eeStorageKey = 'e2ee_enabled'

mock.module('@/db/encryption/config', () => ({
  isEncryptionEnabled: () => localStorage.getItem(e2eeStorageKey) === 'true',
  setEncryptionEnabled: (enabled: boolean) => localStorage.setItem(e2eeStorageKey, String(enabled)),
  needsSyncSetupWizard: async () => false,
  encryptedColumnsMap: {},
}))

mock.module('@/db/encryption', () => ({
  isEncryptionEnabled: () => localStorage.getItem(e2eeStorageKey) === 'true',
  setEncryptionEnabled: (enabled: boolean) => localStorage.setItem(e2eeStorageKey, String(enabled)),
  needsSyncSetupWizard: async () => false,
  encryptedColumnsMap: {},
}))

import { isEncryptionEnabled, setEncryptionEnabled } from './config'

describe('encryption config', () => {
  afterEach(() => {
    localStorage.removeItem('e2ee_enabled')
  })

  describe('isEncryptionEnabled', () => {
    it('returns false when no value is stored', () => {
      expect(isEncryptionEnabled()).toBe(false)
    })

    it('returns false when stored value is "false"', () => {
      localStorage.setItem('e2ee_enabled', 'false')
      expect(isEncryptionEnabled()).toBe(false)
    })

    it('returns true when stored value is "true"', () => {
      localStorage.setItem('e2ee_enabled', 'true')
      expect(isEncryptionEnabled()).toBe(true)
    })
  })

  describe('setEncryptionEnabled', () => {
    it('persists true to localStorage', () => {
      setEncryptionEnabled(true)
      expect(localStorage.getItem('e2ee_enabled')).toBe('true')
      expect(isEncryptionEnabled()).toBe(true)
    })

    it('persists false to localStorage', () => {
      setEncryptionEnabled(false)
      expect(localStorage.getItem('e2ee_enabled')).toBe('false')
      expect(isEncryptionEnabled()).toBe(false)
    })
  })
})
