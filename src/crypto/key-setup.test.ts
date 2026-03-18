import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { _clearCache } from './master-key'
import { createNewKey, importFromPassphrase, importFromRecoveryKey } from './key-setup'
import { exportKeyBytes } from './primitives'
import { getMasterKey } from './master-key'

describe('key setup service', () => {
  beforeEach(() => {
    localStorage.clear()
    _clearCache()
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
  })

  describe('createNewKey', () => {
    test('creates a random key without passphrase', async () => {
      const { result, recoveryKey } = await createNewKey()
      expect(result.success).toBe(true)
      expect(recoveryKey).toMatch(/^[0-9a-f]{64}$/)

      const masterKey = await getMasterKey()
      expect(masterKey).not.toBeNull()
    })

    test('creates a key derived from passphrase', async () => {
      const { result, recoveryKey } = await createNewKey('my secret passphrase')
      expect(result.success).toBe(true)
      expect(recoveryKey).toMatch(/^[0-9a-f]{64}$/)
    })

    test('stores canary in localStorage', async () => {
      await createNewKey()
      const canary = localStorage.getItem('thunderbolt_enc_canary')
      expect(canary).not.toBeNull()
      const parsed = JSON.parse(canary!)
      expect(parsed.version).toBe('v1')
    })

    test('stores salt when passphrase is provided', async () => {
      await createNewKey('passphrase')
      expect(localStorage.getItem('thunderbolt_enc_salt')).not.toBeNull()
    })
  })

  describe('importFromPassphrase', () => {
    test('succeeds with correct passphrase', async () => {
      await createNewKey('my passphrase')
      const originalKey = await getMasterKey()
      const originalBytes = await exportKeyBytes(originalKey!)

      // Simulate re-import on another device (clear key but keep salt + canary)
      localStorage.removeItem('thunderbolt_enc_key')
      localStorage.removeItem('thunderbolt_key_state')
      _clearCache()

      const result = await importFromPassphrase('my passphrase')
      expect(result.success).toBe(true)

      const importedKey = await getMasterKey()
      const importedBytes = await exportKeyBytes(importedKey!)
      expect(importedBytes).toEqual(originalBytes)
    })

    test('fails with wrong passphrase', async () => {
      await createNewKey('correct passphrase')

      localStorage.removeItem('thunderbolt_enc_key')
      localStorage.removeItem('thunderbolt_key_state')
      _clearCache()

      const result = await importFromPassphrase('wrong passphrase')
      expect(result).toEqual({ success: false, error: 'WRONG_KEY' })
    })

    test('fails when no salt is stored', async () => {
      await createNewKey() // random key, no passphrase = no salt
      localStorage.removeItem('thunderbolt_enc_salt')

      const result = await importFromPassphrase('any passphrase')
      expect(result).toEqual({ success: false, error: 'WRONG_KEY' })
    })
  })

  describe('importFromRecoveryKey', () => {
    test('succeeds with correct recovery key', async () => {
      const { recoveryKey } = await createNewKey()
      const originalKey = await getMasterKey()
      const originalBytes = await exportKeyBytes(originalKey!)

      // Simulate re-import
      localStorage.removeItem('thunderbolt_enc_key')
      localStorage.removeItem('thunderbolt_key_state')
      _clearCache()

      const result = await importFromRecoveryKey(recoveryKey)
      expect(result.success).toBe(true)

      const importedKey = await getMasterKey()
      const importedBytes = await exportKeyBytes(importedKey!)
      expect(importedBytes).toEqual(originalBytes)
    })

    test('fails with wrong recovery key', async () => {
      await createNewKey()

      localStorage.removeItem('thunderbolt_enc_key')
      localStorage.removeItem('thunderbolt_key_state')
      _clearCache()

      const wrongKey = 'a'.repeat(64)
      const result = await importFromRecoveryKey(wrongKey)
      expect(result).toEqual({ success: false, error: 'WRONG_KEY' })
    })

    test('fails with invalid format', async () => {
      const result = await importFromRecoveryKey('not-a-hex-key')
      expect(result).toEqual({ success: false, error: 'INVALID_FORMAT' })
    })

    test('recovery key from passphrase-based key also works', async () => {
      const { recoveryKey } = await createNewKey('my passphrase')

      localStorage.removeItem('thunderbolt_enc_key')
      localStorage.removeItem('thunderbolt_key_state')
      _clearCache()

      const result = await importFromRecoveryKey(recoveryKey)
      expect(result.success).toBe(true)
    })
  })
})
