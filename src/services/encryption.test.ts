import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'
import type { KyInstance } from 'ky'

// Mock crypto module before importing the service
const mockKeyPair = {
  privateKey: 'mock-private-key' as unknown as CryptoKey,
  publicKey: 'mock-public-key' as unknown as CryptoKey,
}
const mockCK = 'mock-ck' as unknown as CryptoKey
const mockExtractableCK = 'mock-extractable-ck' as unknown as CryptoKey

const cryptoMocks = {
  generateKeyPair: mock(async () => mockKeyPair),
  generateCK: mock(async () => mockExtractableCK),
  reimportAsNonExtractable: mock(async () => mockCK),
  exportPublicKey: mock(async () => 'mock-public-key-base64'),
  importPublicKey: mock(async () => 'mock-imported-public-key' as unknown as CryptoKey),
  wrapCK: mock(async () => 'mock-wrapped-ck'),
  rewrapCK: mock(async () => 'mock-rewrapped-ck'),
  unwrapCK: mock(async () => mockCK),
  createCanary: mock(async () => ({ canaryIv: 'mock-iv', canaryCtext: 'mock-ctext', canarySecret: 'mock-secret' })),
  verifyCanary: mock(async () => ({ valid: true, canarySecret: 'mock-secret' })),
  encodeRecoveryKey: mock(async () => 'a'.repeat(64)),
  decodeRecoveryKey: mock(async () => mockCK),
  encrypt: mock(async () => ({ iv: '', ciphertext: '' })),
  decrypt: mock(async () => ''),
  storeKeyPair: mock(async () => {}),
  getKeyPair: mock(async () => null as { privateKey: CryptoKey; publicKey: CryptoKey } | null),
  storeCK: mock(async () => {}),
  getCK: mock(async () => null as CryptoKey | null),
  clearCK: mock(async () => {}),
  clearAllKeys: mock(async () => {}),
}

mock.module('@/crypto', () => cryptoMocks)

const apiMocks = {
  registerDevice: mock(async () => ({ trusted: false as const })),
  storeEnvelope: mock(async () => ({ trusted: true as const })),
  fetchMyEnvelope: mock(async () => ({ trusted: true, wrappedCK: 'mock-wrapped-ck' })),
  fetchCanary: mock(async () => ({ canaryIv: 'mock-iv', canaryCtext: 'mock-ctext' })),
}

mock.module('@/api/encryption', () => apiMocks)

// Import after mocking
const {
  registerThisDevice,
  completeFirstDeviceSetup,
  approveDevice,
  checkApprovalAndUnwrap,
  recoverWithKey,
  handleFullWipe,
} = await import('./encryption')

const deviceIdKey = 'thunderbolt_device_id'
const authTokenKey = 'thunderbolt_auth_token'

const mockHttpClient = {} as KyInstance

const resetAllMocks = () => {
  Object.values(cryptoMocks).forEach((m) => m.mockClear())
  Object.values(apiMocks).forEach((m) => m.mockClear())

  // Reset default return values
  cryptoMocks.generateKeyPair.mockImplementation(async () => mockKeyPair)
  cryptoMocks.generateCK.mockImplementation(async () => mockExtractableCK)
  cryptoMocks.reimportAsNonExtractable.mockImplementation(async () => mockCK)
  cryptoMocks.exportPublicKey.mockImplementation(async () => 'mock-public-key-base64')
  cryptoMocks.importPublicKey.mockImplementation(async () => 'mock-imported-public-key' as unknown as CryptoKey)
  cryptoMocks.wrapCK.mockImplementation(async () => 'mock-wrapped-ck')
  cryptoMocks.rewrapCK.mockImplementation(async () => 'mock-rewrapped-ck')
  cryptoMocks.unwrapCK.mockImplementation(async () => mockCK)
  cryptoMocks.createCanary.mockImplementation(async () => ({
    canaryIv: 'mock-iv',
    canaryCtext: 'mock-ctext',
    canarySecret: 'mock-secret',
  }))
  cryptoMocks.verifyCanary.mockImplementation(async () => ({ valid: true, canarySecret: 'mock-secret' }))
  cryptoMocks.encodeRecoveryKey.mockImplementation(async () => 'a'.repeat(64))
  cryptoMocks.decodeRecoveryKey.mockImplementation(async () => mockCK)
  cryptoMocks.encrypt.mockImplementation(async () => ({ iv: '', ciphertext: '' }))
  cryptoMocks.decrypt.mockImplementation(async () => '')
  cryptoMocks.storeKeyPair.mockImplementation(async () => {})
  cryptoMocks.getKeyPair.mockImplementation(async () => null)
  cryptoMocks.storeCK.mockImplementation(async () => {})
  cryptoMocks.getCK.mockImplementation(async () => null)
  cryptoMocks.clearCK.mockImplementation(async () => {})
  cryptoMocks.clearAllKeys.mockImplementation(async () => {})

  apiMocks.registerDevice.mockImplementation(async () => ({ trusted: false as const }))
  apiMocks.storeEnvelope.mockImplementation(async () => ({ trusted: true as const }))
  apiMocks.fetchMyEnvelope.mockImplementation(async () => ({ trusted: true, wrappedCK: 'mock-wrapped-ck' }))
  apiMocks.fetchCanary.mockImplementation(async () => ({ canaryIv: 'mock-iv', canaryCtext: 'mock-ctext' }))
}

describe('encryption service', () => {
  beforeEach(() => {
    localStorage.setItem(deviceIdKey, 'test-device-id')
    localStorage.setItem(authTokenKey, 'test-token')
    resetAllMocks()
  })

  afterEach(() => {
    localStorage.removeItem(deviceIdKey)
    localStorage.removeItem(authTokenKey)
  })

  describe('registerThisDevice', () => {
    it('generates new key pair when none exists', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => null)

      const result = await registerThisDevice(mockHttpClient)

      expect(cryptoMocks.generateKeyPair).toHaveBeenCalledTimes(1)
      expect(cryptoMocks.storeKeyPair).toHaveBeenCalledWith(mockKeyPair.privateKey, mockKeyPair.publicKey)
      expect(cryptoMocks.exportPublicKey).toHaveBeenCalledWith(mockKeyPair.publicKey)
      expect(apiMocks.registerDevice).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ trusted: false })
    })

    it('reuses existing key pair', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => mockKeyPair)

      await registerThisDevice(mockHttpClient)

      expect(cryptoMocks.generateKeyPair).not.toHaveBeenCalled()
      expect(cryptoMocks.storeKeyPair).not.toHaveBeenCalled()
      expect(cryptoMocks.exportPublicKey).toHaveBeenCalledWith(mockKeyPair.publicKey)
    })

    it('passes device ID and public key to API', async () => {
      await registerThisDevice(mockHttpClient)

      expect(apiMocks.registerDevice).toHaveBeenCalledWith(mockHttpClient, {
        deviceId: 'test-device-id',
        publicKey: 'mock-public-key-base64',
        name: expect.any(String),
      })
    })
  })

  describe('completeFirstDeviceSetup', () => {
    it('generates CK, canary, envelope, stores keys, returns recovery key', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => mockKeyPair)

      const recoveryKey = await completeFirstDeviceSetup(mockHttpClient)

      // Should generate extractable CK
      expect(cryptoMocks.generateCK).toHaveBeenCalledWith(true)
      // Should encode recovery key
      expect(cryptoMocks.encodeRecoveryKey).toHaveBeenCalledWith(mockExtractableCK)
      // Should create canary
      expect(cryptoMocks.createCanary).toHaveBeenCalledWith(mockExtractableCK)
      // Should wrap CK with own public key
      expect(cryptoMocks.wrapCK).toHaveBeenCalledWith(mockExtractableCK, mockKeyPair.publicKey)
      // Should reimport as non-extractable
      expect(cryptoMocks.reimportAsNonExtractable).toHaveBeenCalledWith(mockExtractableCK)
      // Should store envelope with canary and secret
      expect(apiMocks.storeEnvelope).toHaveBeenCalledWith(mockHttpClient, {
        deviceId: 'test-device-id',
        wrappedCK: 'mock-wrapped-ck',
        canaryIv: 'mock-iv',
        canaryCtext: 'mock-ctext',
        canarySecret: 'mock-secret',
      })
      // Should store CK locally
      expect(cryptoMocks.storeCK).toHaveBeenCalledWith(mockCK)
      // Should return recovery key
      expect(recoveryKey).toBe('a'.repeat(64))
    })

    it('throws if key pair is missing', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => null)

      await expect(completeFirstDeviceSetup(mockHttpClient)).rejects.toThrow('Key pair not found')
    })
  })

  describe('approveDevice', () => {
    it('fetches own envelope, rewraps CK for pending device, stores envelope', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => mockKeyPair)

      await approveDevice(mockHttpClient, 'pending-dev', 'pending-pub-key-base64')

      expect(apiMocks.fetchMyEnvelope).toHaveBeenCalledWith(mockHttpClient)
      expect(cryptoMocks.importPublicKey).toHaveBeenCalledWith('pending-pub-key-base64')
      expect(cryptoMocks.rewrapCK).toHaveBeenCalledWith(
        'mock-wrapped-ck',
        mockKeyPair.privateKey,
        'mock-imported-public-key',
      )
      expect(apiMocks.storeEnvelope).toHaveBeenCalledWith(mockHttpClient, {
        deviceId: 'pending-dev',
        wrappedCK: 'mock-rewrapped-ck',
      })
    })

    it('throws if key pair is missing', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => null)

      await expect(approveDevice(mockHttpClient, 'dev', 'key')).rejects.toThrow('Key pair not found')
    })
  })

  describe('checkApprovalAndUnwrap', () => {
    it('fetches envelope, unwraps CK, stores it, returns true', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => mockKeyPair)

      const result = await checkApprovalAndUnwrap(mockHttpClient)

      expect(apiMocks.fetchMyEnvelope).toHaveBeenCalledWith(mockHttpClient)
      expect(cryptoMocks.unwrapCK).toHaveBeenCalledWith('mock-wrapped-ck', mockKeyPair.privateKey)
      expect(cryptoMocks.storeCK).toHaveBeenCalledWith(mockCK)
      expect(result).toBe(true)
    })

    it('returns false when envelope fetch returns 404 (not yet approved)', async () => {
      const notFoundError = Object.assign(new Error('Not found'), { response: { status: 404 } })
      apiMocks.fetchMyEnvelope.mockImplementation(async () => {
        throw notFoundError
      })

      const result = await checkApprovalAndUnwrap(mockHttpClient)
      expect(result).toBe(false)
    })

    it('throws when envelope fetch fails with non-404 error', async () => {
      apiMocks.fetchMyEnvelope.mockImplementation(async () => {
        throw new Error('Network error')
      })

      await expect(checkApprovalAndUnwrap(mockHttpClient)).rejects.toThrow('Network error')
    })

    it('throws when key pair is missing', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => null)

      await expect(checkApprovalAndUnwrap(mockHttpClient)).rejects.toThrow('Key pair not found')
    })
  })

  describe('recoverWithKey', () => {
    it('verifies canary, registers device, stores envelope and CK', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => null)

      await recoverWithKey(mockHttpClient, 'a'.repeat(64))

      // Should fetch canary
      expect(apiMocks.fetchCanary).toHaveBeenCalledWith(mockHttpClient)
      // Should decode recovery key
      expect(cryptoMocks.decodeRecoveryKey).toHaveBeenCalledWith('a'.repeat(64))
      // Should verify canary
      expect(cryptoMocks.verifyCanary).toHaveBeenCalledWith(mockCK, 'mock-iv', 'mock-ctext')
      // Should generate new key pair (none existed)
      expect(cryptoMocks.generateKeyPair).toHaveBeenCalledTimes(1)
      expect(cryptoMocks.storeKeyPair).toHaveBeenCalled()
      // Should register device
      expect(apiMocks.registerDevice).toHaveBeenCalledTimes(1)
      // Should store envelope with canarySecret (proof-of-possession, no canaryIv/canaryCtext)
      expect(apiMocks.storeEnvelope).toHaveBeenCalledWith(mockHttpClient, {
        deviceId: 'test-device-id',
        wrappedCK: 'mock-wrapped-ck',
        canarySecret: 'mock-secret',
      })
      // Should reimport CK as non-extractable before storing
      expect(cryptoMocks.reimportAsNonExtractable).toHaveBeenCalledWith(mockCK)
      // Should store non-extractable CK
      expect(cryptoMocks.storeCK).toHaveBeenCalledWith(mockCK)
    })

    it('reuses existing key pair during recovery', async () => {
      cryptoMocks.getKeyPair.mockImplementation(async () => mockKeyPair)

      await recoverWithKey(mockHttpClient, 'a'.repeat(64))

      expect(cryptoMocks.generateKeyPair).not.toHaveBeenCalled()
    })

    it('throws on invalid recovery key (canary verification fails)', async () => {
      cryptoMocks.verifyCanary.mockImplementation(async () => ({ valid: false }))

      await expect(recoverWithKey(mockHttpClient, 'b'.repeat(64))).rejects.toThrow('Invalid recovery key')
    })
  })

  describe('handleFullWipe', () => {
    it('clears all keys', async () => {
      await handleFullWipe()

      expect(cryptoMocks.clearAllKeys).toHaveBeenCalledTimes(1)
    })
  })
})
