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

const { codec, invalidateCKCache } = await import('./codec')

describe('AES-GCM codec', () => {
  beforeEach(async () => {
    invalidateCKCache()
    mockGetCKReturn = await generateCK()
  })

  afterEach(() => {
    invalidateCKCache()
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
      const result = await codec.encode('b')
      expect(result).toBe('b')
    })
  })
})
