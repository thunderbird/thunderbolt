import { describe, expect, it } from 'bun:test'
import { encodeRecoveryKey, decodeRecoveryKey } from './recovery-key'
import { generateCK, encrypt, decrypt } from './primitives'

describe('encodeRecoveryKey', () => {
  it('produces a 64-character hex string', async () => {
    const ck = await generateCK(true)
    const recoveryKey = await encodeRecoveryKey(ck)
    expect(recoveryKey).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(recoveryKey)).toBe(true)
  })
})

describe('decodeRecoveryKey', () => {
  it('round-trips: encode then decode produces a working key', async () => {
    const originalCK = await generateCK(true)
    const recoveryKey = await encodeRecoveryKey(originalCK)
    const restoredCK = await decodeRecoveryKey(recoveryKey)

    // Verify the restored key can decrypt data encrypted with the original
    const encrypted = await encrypt('test data', originalCK)
    const decrypted = await decrypt(encrypted, restoredCK)
    expect(decrypted).toBe('test data')
  })

  it('accepts spaces in the input', async () => {
    const ck = await generateCK(true)
    const recoveryKey = await encodeRecoveryKey(ck)
    const withSpaces = recoveryKey.match(/.{8}/g)!.join(' ')
    const restored = await decodeRecoveryKey(withSpaces)
    expect(restored.algorithm.name).toBe('AES-GCM')
  })

  it('rejects a key that is too short', async () => {
    await expect(decodeRecoveryKey('abc123')).rejects.toThrow('64 hex characters')
  })

  it('rejects non-hex characters', async () => {
    const badKey = 'g'.repeat(64)
    await expect(decodeRecoveryKey(badKey)).rejects.toThrow('hex characters')
  })
})
