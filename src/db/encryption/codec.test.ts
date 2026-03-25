import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'

const mockCK = 'mock-ck' as unknown as CryptoKey
let mockGetCKReturn: CryptoKey | null = null

/** Safe base64 that handles unicode via URI encoding */
const safeEncode = (str: string) => btoa(unescape(encodeURIComponent(str)))
const safeDecode = (b64: string) => decodeURIComponent(escape(atob(b64)))

const mockEncrypt = mock(async (plaintext: string, _ck: CryptoKey) => ({
  iv: safeEncode(`iv-for-${plaintext.slice(0, 8)}`),
  ciphertext: safeEncode(`ct-for-${plaintext}`),
}))

const mockDecrypt = mock(async (data: { iv: string; ciphertext: string }, _ck: CryptoKey) => {
  const ct = safeDecode(data.ciphertext)
  if (!ct.startsWith('ct-for-')) {
    throw new Error('Decryption failed')
  }
  return ct.slice('ct-for-'.length)
})

mock.module('@/crypto', () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  getCK: async () => mockGetCKReturn,
  generateKeyPair: async () => ({}),
  generateCK: async () => ({}),
  reimportAsNonExtractable: async () => ({}),
  exportPublicKey: async () => '',
  importPublicKey: async () => ({}),
  wrapCK: async () => '',
  rewrapCK: async () => '',
  unwrapCK: async () => ({}),
  createCanary: async () => ({ canaryIv: '', canaryCtext: '' }),
  verifyCanary: async () => true,
  encodeRecoveryKey: async () => '',
  decodeRecoveryKey: async () => ({}),
  storeKeyPair: async () => {},
  getKeyPair: async () => null,
  storeCK: async () => {},
  clearCK: async () => {},
  clearAllKeys: async () => {},
  EncryptionError: class extends Error {},
  DecryptionError: class extends Error {},
  StorageError: class extends Error {},
  ValidationError: class extends Error {},
}))

const { codec, invalidateCKCache } = await import('./codec')

describe('AES-GCM codec', () => {
  beforeEach(() => {
    mockEncrypt.mockClear()
    mockDecrypt.mockClear()
    invalidateCKCache()
    mockGetCKReturn = mockCK
  })

  afterEach(() => {
    invalidateCKCache()
  })

  describe('encode', () => {
    it('produces __enc: prefixed output', async () => {
      const encoded = await codec.encode('hello world')
      expect(encoded.startsWith('__enc:')).toBe(true)
      expect(mockEncrypt).toHaveBeenCalledTimes(1)
    })

    it('passes through when no CK is available', async () => {
      mockGetCKReturn = null
      const result = await codec.encode('hello')
      expect(result).toBe('hello')
      expect(mockEncrypt).not.toHaveBeenCalled()
    })

    it('encodes empty string', async () => {
      const encoded = await codec.encode('')
      expect(encoded.startsWith('__enc:')).toBe(true)
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

    it('handles legacy b64: prefix', async () => {
      const legacy = 'b64:' + btoa(unescape(encodeURIComponent('hello')))
      const decoded = await codec.decode(legacy)
      expect(decoded).toBe('hello')
    })

    it('passes through plaintext (no prefix)', async () => {
      const decoded = await codec.decode('just plain text')
      expect(decoded).toBe('just plain text')
    })

    it('returns as-is for malformed __enc: string', async () => {
      const malformed = '__enc:no-separator-here'
      const decoded = await codec.decode(malformed)
      expect(decoded).toBe(malformed)
    })

    it('returns as-is when decryption fails', async () => {
      mockDecrypt.mockImplementationOnce(async () => {
        throw new Error('bad decrypt')
      })
      const encoded = '__enc:aXY=:Y3Q='
      const decoded = await codec.decode(encoded)
      expect(decoded).toBe(encoded)
    })
  })

  describe('CK cache', () => {
    it('caches CK across calls', async () => {
      await codec.encode('a')
      await codec.encode('b')
      expect(mockEncrypt).toHaveBeenCalledTimes(2)
    })

    it('invalidation forces re-check', async () => {
      await codec.encode('a')
      invalidateCKCache()
      mockGetCKReturn = null
      const result = await codec.encode('b')
      expect(result).toBe('b')
    })
  })
})
