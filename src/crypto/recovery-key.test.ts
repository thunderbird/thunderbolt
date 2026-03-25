import { describe, expect, it } from 'bun:test'

import { encodeRecoveryKey, decodeRecoveryKey } from './recovery-key'
import { generateCK, encrypt, decrypt } from './primitives'

describe('encodeRecoveryKey', () => {
  it('produces a 24-word mnemonic', async () => {
    const ck = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(ck)
    const words = mnemonic.split(' ')
    expect(words).toHaveLength(24)
  })

  it('produces only lowercase words', async () => {
    const ck = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(ck)
    expect(mnemonic).toBe(mnemonic.toLowerCase())
  })
})

describe('decodeRecoveryKey', () => {
  it('round-trips: encode then decode produces a working key', async () => {
    const originalCK = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(originalCK)
    const restoredCK = await decodeRecoveryKey(mnemonic)

    const encrypted = await encrypt('test data', originalCK)
    const decrypted = await decrypt(encrypted, restoredCK)
    expect(decrypted).toBe('test data')
  })

  it('accepts extra whitespace in the input', async () => {
    const ck = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(ck)
    const withExtraSpaces = `  ${mnemonic.replace(/ /g, '   ')}  `
    const restored = await decodeRecoveryKey(withExtraSpaces)
    expect(restored.algorithm.name).toBe('AES-GCM')
  })

  it('accepts mixed case input', async () => {
    const ck = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(ck)
    const restored = await decodeRecoveryKey(mnemonic.toUpperCase())
    expect(restored.algorithm.name).toBe('AES-GCM')
  })

  it('rejects an invalid mnemonic (bad checksum)', async () => {
    const ck = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(ck)
    const words = mnemonic.split(' ')
    ;[words[0], words[1]] = [words[1], words[0]]
    await expect(decodeRecoveryKey(words.join(' '))).rejects.toThrow('Invalid recovery phrase')
  })

  it('rejects a word not in the wordlist', async () => {
    const fakeWords = Array(24).fill('zzzznotaword').join(' ')
    await expect(decodeRecoveryKey(fakeWords)).rejects.toThrow('Invalid recovery phrase')
  })

  it('rejects wrong word count', async () => {
    const ck = await generateCK(true)
    const mnemonic = await encodeRecoveryKey(ck)
    const tooFew = mnemonic.split(' ').slice(0, 12).join(' ')
    await expect(decodeRecoveryKey(tooFew)).rejects.toThrow()
  })
})
