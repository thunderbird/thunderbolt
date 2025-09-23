import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Settings } from '../config/settings'
import { getFlowerApiKey } from './flower'

// Mock fetch globally
const mockFetch = spyOn(globalThis, 'fetch')

describe('Auth - Flower', () => {
  let mockSettings: Settings

  beforeEach(() => {
    mockFetch.mockReset()

    mockSettings = {
      flowerMgmtKey: 'test-mgmt-key',
      flowerProjId: 'test-project-123',
      fireworksApiKey: '',
      exaApiKey: '',
      monitoringToken: '',
      googleClientId: '',
      googleClientSecret: '',
      microsoftClientId: '',
      microsoftClientSecret: '',
      logLevel: 'INFO',
      port: 8000,
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: '',
      corsOrigins: 'http://localhost:1420',
      corsOriginRegex: '',
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders:
        'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With',
      corsExposeHeaders: 'mcp-session-id',
    }
  })

  describe('getFlowerApiKey', () => {
    it('should successfully request API key with valid settings', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ api_key: 'flower-api-key-123' }),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      const result = await getFlowerApiKey('user-hash-123', undefined, mockSettings)

      expect(result).toBe('flower-api-key-123')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.flower.ai/v1/organization/projects/test-project-123/api_keys',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-mgmt-key',
          },
          body: JSON.stringify({
            billing_id: 'user-hash-123',
          }),
        },
      )
    })

    it('should include expires_at when provided', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ api_key: 'flower-api-key-123' }),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      const expiresAt = Date.now() + 3600000 // 1 hour from now
      await getFlowerApiKey('user-hash-123', expiresAt, mockSettings)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.flower.ai/v1/organization/projects/test-project-123/api_keys',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-mgmt-key',
          },
          body: JSON.stringify({
            billing_id: 'user-hash-123',
            expires_at: expiresAt,
          }),
        },
      )
    })

    it('should throw error when settings are not provided', async () => {
      await expect(getFlowerApiKey('user-hash-123')).rejects.toThrow('Settings are required')
    })

    it('should throw error when FLOWER_PROJ_ID is missing', async () => {
      const settingsWithoutProjId = { ...mockSettings, flowerProjId: '' }

      await expect(getFlowerApiKey('user-hash-123', undefined, settingsWithoutProjId)).rejects.toThrow(
        'FLOWER_PROJ_ID must be set in environment variables',
      )
    })

    it('should throw error when FLOWER_MGMT_KEY is missing', async () => {
      const settingsWithoutMgmtKey = { ...mockSettings, flowerMgmtKey: '' }

      await expect(getFlowerApiKey('user-hash-123', undefined, settingsWithoutMgmtKey)).rejects.toThrow(
        'FLOWER_MGMT_KEY must be set in environment variables',
      )
    })

    it('should handle HTTP error responses', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      await expect(getFlowerApiKey('user-hash-123', undefined, mockSettings)).rejects.toThrow(
        'Error when requesting Flower API key: 401 Unauthorized',
      )
    })

    it('should handle missing api_key in response', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ error: 'No API key' }),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      await expect(getFlowerApiKey('user-hash-123', undefined, mockSettings)).rejects.toThrow(
        'Bad response from Flower API server',
      )
    })

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      await expect(getFlowerApiKey('user-hash-123', undefined, mockSettings)).rejects.toThrow(
        'Error when requesting Flower API key: Network error',
      )
    })

    it('should handle non-Error exceptions', async () => {
      mockFetch.mockRejectedValueOnce('String error')

      await expect(getFlowerApiKey('user-hash-123', undefined, mockSettings)).rejects.toThrow(
        'Unknown error when requesting Flower API key',
      )
    })

    it('should handle JSON parsing errors', async () => {
      const mockResponse = {
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON')
        },
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      await expect(getFlowerApiKey('user-hash-123', undefined, mockSettings)).rejects.toThrow(
        'Error when requesting Flower API key: Invalid JSON',
      )
    })

    it('should use correct URL format', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ api_key: 'flower-api-key-123' }),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      await getFlowerApiKey('user-hash-123', undefined, mockSettings)

      const expectedUrl = 'https://api.flower.ai/v1/organization/projects/test-project-123/api_keys'
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object))
    })

    it('should handle different project ID formats', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ api_key: 'flower-api-key-123' }),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as any)

      const settingsWithUuidProjId = { ...mockSettings, flowerProjId: 'proj-uuid-12345-67890' }
      await getFlowerApiKey('user-hash-123', undefined, settingsWithUuidProjId)

      const expectedUrl = 'https://api.flower.ai/v1/organization/projects/proj-uuid-12345-67890/api_keys'
      expect(mockFetch).toHaveBeenCalledWith(expectedUrl, expect.any(Object))
    })
  })
})
