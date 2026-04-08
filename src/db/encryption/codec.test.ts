import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import { generateCK } from '@/crypto'

let mockGetCKReturn: CryptoKey | null = null

mock.module('@/crypto/key-storage', () => ({
  getCK: async () => mockGetCKReturn,
  storeCK: async () => {},
  storeKeyPair: async () => {},
  getKeyPair: async () => null,
  clearCK: async () => {},
  clearAllKeys: async () => {},
}))

const { codec, invalidateCKCache, resetCodecState } = await import('./codec')

describe('AES-GCM codec', () => {
  beforeEach(async () => {
    resetCodecState()
    mockGetCKReturn = await generateCK()
  })

  afterEach(() => {
    resetCodecState()
  })

  describe('encode', () => {
    it('produces __enc: prefixed output', async () => {
      const encoded = await codec.encode('hello world')
      expect(encoded.startsWith('__enc:')).toBe(true)
    })

    it('passes through when no CK is available', async () => {
      mockGetCKReturn = null
      invalidateCKCache()
      const result = await codec.encode('hello')
      expect(result).toBe('hello')
    })

    it('encodes empty string', async () => {
      const encoded = await codec.encode('')
      expect(encoded.startsWith('__enc:')).toBe(true)
    })

    it('skips already-encrypted values (no double encryption)', async () => {
      const encoded = await codec.encode('hello')
      expect(encoded.startsWith('__enc:')).toBe(true)

      const doubleEncoded = await codec.encode(encoded)
      expect(doubleEncoded).toBe(encoded)
    })
  })

  describe('decode', () => {
    it('round-trips through encode → decode', async () => {
      const original = 'hello world'
      const encoded = await codec.encode(original)
      const decoded = await codec.decode(encoded)
      expect(decoded).toBe(original)
    })

    it('round-trips unicode content', async () => {
      const original = 'Hello 🌍 café résumé'
      const encoded = await codec.encode(original)
      const decoded = await codec.decode(encoded)
      expect(decoded).toBe(original)
    })

    it('returns as-is for __enc: prefix when no CK', async () => {
      const encoded = await codec.encode('test')
      invalidateCKCache()
      mockGetCKReturn = null
      const decoded = await codec.decode(encoded)
      expect(decoded).toBe(encoded)
    })

    it('passes through plaintext (no double decryption attempt)', async () => {
      const plaintext = 'just plain text'
      const decoded = await codec.decode(plaintext)
      expect(decoded).toBe(plaintext)
    })

    it('returns as-is for malformed __enc: string', async () => {
      const malformed = '__enc:no-separator-here'
      const decoded = await codec.decode(malformed)
      expect(decoded).toBe(malformed)
    })

    it('returns as-is when decryption fails', async () => {
      // Forge a value with the __enc: prefix but invalid ciphertext
      const invalid = '__enc:aXY=:Y3Q='
      const decoded = await codec.decode(invalid)
      expect(decoded).toBe(invalid)
    })
  })

  describe('CK cache', () => {
    it('caches CK across calls (both calls succeed)', async () => {
      const a = await codec.encode('a')
      const b = await codec.encode('b')
      expect(a.startsWith('__enc:')).toBe(true)
      expect(b.startsWith('__enc:')).toBe(true)
    })

    it('invalidation forces re-check', async () => {
      const a = await codec.encode('a')
      expect(a.startsWith('__enc:')).toBe(true)

      invalidateCKCache()
      mockGetCKReturn = null
      // After invalidation in recovery flow (CK re-stored), getCK returns null
      // but e2eeSetupComplete is still true — this simulates the gap
      expect(codec.encode('b')).rejects.toThrow('Content key unavailable after E2EE setup')
    })

    it('throws when CK disappears after E2EE setup', async () => {
      // First encode loads CK and sets e2eeSetupComplete = true
      const encoded = await codec.encode('secret')
      expect(encoded.startsWith('__enc:')).toBe(true)

      // Simulate CK becoming unavailable (e.g. IndexedDB cleared mid-session)
      invalidateCKCache()
      mockGetCKReturn = null

      expect(codec.encode('should-not-be-plaintext')).rejects.toThrow('Content key unavailable after E2EE setup')
    })

    it('resetCodecState clears setup flag so encode passes through', async () => {
      // Load CK (sets e2eeSetupComplete = true)
      await codec.encode('setup')

      // Full reset (sign-out) clears both cache and setup flag
      resetCodecState()
      mockGetCKReturn = null

      // Now encode should pass through (pre-setup behavior)
      const result = await codec.encode('hello')
      expect(result).toBe('hello')
    })
  })
})
