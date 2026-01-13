import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { _resetCacheForTesting, clearAuthToken, getAuthToken, loadAuthToken, setAuthToken } from './auth-token'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  _resetCacheForTesting()
})

describe('auth-token', () => {
  describe('getAuthToken', () => {
    it('returns null when no token is cached', () => {
      expect(getAuthToken()).toBeNull()
    })

    it('returns cached token after setAuthToken', async () => {
      await setAuthToken('test-token-123')
      expect(getAuthToken()).toBe('test-token-123')
    })
  })

  describe('setAuthToken', () => {
    it('stores token in memory cache', async () => {
      await setAuthToken('cached-token')
      expect(getAuthToken()).toBe('cached-token')
    })

    it('persists token to settings database', async () => {
      await setAuthToken('persisted-token')

      // Reset cache to simulate app restart
      _resetCacheForTesting()
      expect(getAuthToken()).toBeNull()

      // Load from database should restore the token
      await loadAuthToken()
      expect(getAuthToken()).toBe('persisted-token')
    })

    it('removes token from database when set to null', async () => {
      await setAuthToken('token-to-remove')
      expect(getAuthToken()).toBe('token-to-remove')

      await setAuthToken(null)
      expect(getAuthToken()).toBeNull()

      // Verify it's also removed from database
      _resetCacheForTesting()
      await loadAuthToken()
      expect(getAuthToken()).toBeNull()
    })
  })

  describe('loadAuthToken', () => {
    it('loads token from database into cache', async () => {
      // Store token and reset cache
      await setAuthToken('db-token')
      _resetCacheForTesting()

      expect(getAuthToken()).toBeNull()

      await loadAuthToken()
      expect(getAuthToken()).toBe('db-token')
    })

    it('sets cache to null when no token in database', async () => {
      await loadAuthToken()
      expect(getAuthToken()).toBeNull()
    })
  })

  describe('clearAuthToken', () => {
    it('clears token from cache', async () => {
      await setAuthToken('token-to-clear')
      expect(getAuthToken()).toBe('token-to-clear')

      await clearAuthToken()
      expect(getAuthToken()).toBeNull()
    })

    it('clears token from database', async () => {
      await setAuthToken('persistent-token')

      await clearAuthToken()

      // Verify cache is cleared
      expect(getAuthToken()).toBeNull()

      // Verify database is cleared
      _resetCacheForTesting()
      await loadAuthToken()
      expect(getAuthToken()).toBeNull()
    })
  })
})
