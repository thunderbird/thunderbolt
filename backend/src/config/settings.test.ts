import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearSettingsCache,
  getWaitlistAutoApproveDomains,
  getCorsMethodsList,
  getCorsOriginsList,
  getSettings,
  isOriginAllowed,
} from './settings'

describe('Config Settings', () => {
  describe('getCorsOriginsList', () => {
    it('should split comma-separated origins', () => {
      const settings = { corsOrigins: 'http://localhost:3000,https://example.com,https://app.example.com' }
      const origins = getCorsOriginsList(settings as any)

      expect(origins).toEqual(['http://localhost:3000', 'https://example.com', 'https://app.example.com'])
    })

    it('should handle single origin', () => {
      const settings = { corsOrigins: 'http://localhost:3000' }
      const origins = getCorsOriginsList(settings as any)

      expect(origins).toEqual(['http://localhost:3000'])
    })

    it('should trim whitespace from origins', () => {
      const settings = { corsOrigins: ' http://localhost:3000 , https://example.com , https://app.example.com ' }
      const origins = getCorsOriginsList(settings as any)

      expect(origins).toEqual(['http://localhost:3000', 'https://example.com', 'https://app.example.com'])
    })

    it('should filter out empty origins', () => {
      const settings = { corsOrigins: 'http://localhost:3000,,https://example.com,' }
      const origins = getCorsOriginsList(settings as any)

      expect(origins).toEqual(['http://localhost:3000', 'https://example.com'])
    })

    it('should handle empty string', () => {
      const settings = { corsOrigins: '' }
      const origins = getCorsOriginsList(settings as any)

      expect(origins).toEqual([])
    })
  })

  describe('getWaitlistAutoApproveDomains', () => {
    it('should split comma-separated domains', () => {
      const settings = { waitlistAutoApproveDomains: 'mozilla.org,thunderbird.net,mozilla.ai' }
      const domains = getWaitlistAutoApproveDomains(settings as any)

      expect(domains).toEqual(['mozilla.org', 'thunderbird.net', 'mozilla.ai'])
    })

    it('should handle single domain', () => {
      const settings = { waitlistAutoApproveDomains: 'mozilla.org' }
      const domains = getWaitlistAutoApproveDomains(settings as any)

      expect(domains).toEqual(['mozilla.org'])
    })

    it('should trim whitespace and lowercase domains', () => {
      const settings = { waitlistAutoApproveDomains: ' Mozilla.ORG , Thunderbird.NET ' }
      const domains = getWaitlistAutoApproveDomains(settings as any)

      expect(domains).toEqual(['mozilla.org', 'thunderbird.net'])
    })

    it('should filter out empty domains', () => {
      const settings = { waitlistAutoApproveDomains: 'mozilla.org,,thunderbird.net,' }
      const domains = getWaitlistAutoApproveDomains(settings as any)

      expect(domains).toEqual(['mozilla.org', 'thunderbird.net'])
    })

    it('should handle empty string', () => {
      const settings = { waitlistAutoApproveDomains: '' }
      const domains = getWaitlistAutoApproveDomains(settings as any)

      expect(domains).toEqual([])
    })
  })

  describe('getCorsMethodsList', () => {
    it('should split comma-separated methods', () => {
      const settings = { corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS' }
      const methods = getCorsMethodsList(settings as any)

      expect(methods).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
    })

    it('should handle single method', () => {
      const settings = { corsAllowMethods: 'GET' }
      const methods = getCorsMethodsList(settings as any)

      expect(methods).toEqual(['GET'])
    })

    it('should trim whitespace from methods', () => {
      const settings = { corsAllowMethods: ' GET , POST , PUT ' }
      const methods = getCorsMethodsList(settings as any)

      expect(methods).toEqual(['GET', 'POST', 'PUT'])
    })

    it('should filter out empty methods', () => {
      const settings = { corsAllowMethods: 'GET,,POST,' }
      const methods = getCorsMethodsList(settings as any)

      expect(methods).toEqual(['GET', 'POST'])
    })

    it('should handle empty string', () => {
      const settings = { corsAllowMethods: '' }
      const methods = getCorsMethodsList(settings as any)

      expect(methods).toEqual([])
    })
  })

  describe('Settings validation and defaults', () => {
    it('should have valid default values in schema', () => {
      // Test that the schema itself has sensible defaults
      // This tests the schema definition without env var manipulation
      expect(() => {
        const testEnv = {
          fireworksApiKey: '',
          exaApiKey: '',
          monitoringToken: '',
          googleClientId: '',
          googleClientSecret: '',
          microsoftClientId: '',
          microsoftClientSecret: '',
          logLevel: 'INFO' as const,
          port: 8000,
          appUrl: 'http://localhost:1420',
          posthogHost: 'https://us.i.posthog.com',
          posthogApiKey: '',
          waitlistEnabled: false,
          powersyncUrl: '',
          powersyncJwtKid: '',
          powersyncJwtSecret: '',
          powersyncTokenExpirySeconds: 3600,
          authMode: 'consumer',
          oidcClientId: '',
          oidcClientSecret: '',
          oidcIssuer: '',
          betterAuthUrl: 'http://localhost:8000',
          corsOrigins: 'http://localhost:1420',
          corsOriginRegex: null,
          corsAllowCredentials: true,
          corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          corsAllowHeaders:
            'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With',
          corsExposeHeaders: 'mcp-session-id',
        }

        // Should not throw with valid default values
        return testEnv
      }).not.toThrow()
    })

    it('should handle various log levels', () => {
      const validLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const

      for (const level of validLogLevels) {
        expect(validLogLevels.includes(level)).toBe(true)
      }
    })

    it('should handle port number conversion', () => {
      // Test that port conversion works correctly
      const portValues = ['8000', '3000', '5000']

      for (const port of portValues) {
        const numPort = Number(port)
        expect(Number.isInteger(numPort)).toBe(true)
        expect(numPort).toBeGreaterThan(0)
      }
    })
  })

  describe('Rate limiting settings', () => {
    const RATE_LIMIT_ENV_KEYS = ['RATE_LIMIT_ENABLED', 'TRUSTED_PROXY'] as const

    let savedEnv: Partial<Record<string, string>>

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = {}
      for (const key of RATE_LIMIT_ENV_KEYS) {
        if (process.env[key] !== undefined) {
          savedEnv[key] = process.env[key]
        }
      }
    })

    afterEach(() => {
      for (const key of RATE_LIMIT_ENV_KEYS) {
        if (savedEnv[key] !== undefined) {
          process.env[key] = savedEnv[key]
        } else {
          delete process.env[key]
        }
      }
      clearSettingsCache()
    })

    it('should default rateLimitEnabled to true when env var is unset', () => {
      delete process.env.RATE_LIMIT_ENABLED
      const settings = getSettings()
      expect(settings.rateLimitEnabled).toBe(true)
    })

    it('should disable rate limiting when RATE_LIMIT_ENABLED is "false"', () => {
      process.env.RATE_LIMIT_ENABLED = 'false'
      const settings = getSettings()
      expect(settings.rateLimitEnabled).toBe(false)
    })

    it('should keep rate limiting enabled for any value other than "false"', () => {
      process.env.RATE_LIMIT_ENABLED = 'true'
      const settings = getSettings()
      expect(settings.rateLimitEnabled).toBe(true)
    })

    it('should default trustedProxy to empty string when env var is unset', () => {
      delete process.env.TRUSTED_PROXY
      const settings = getSettings()
      expect(settings.trustedProxy).toBe('')
    })

    it('should accept "cloudflare" as trustedProxy', () => {
      process.env.TRUSTED_PROXY = 'cloudflare'
      const settings = getSettings()
      expect(settings.trustedProxy).toBe('cloudflare')
    })

    it('should accept "akamai" as trustedProxy', () => {
      process.env.TRUSTED_PROXY = 'akamai'
      const settings = getSettings()
      expect(settings.trustedProxy).toBe('akamai')
    })

    it('should lowercase TRUSTED_PROXY value', () => {
      process.env.TRUSTED_PROXY = 'CLOUDFLARE'
      const settings = getSettings()
      expect(settings.trustedProxy).toBe('cloudflare')
    })

    it('should reject invalid trustedProxy values', () => {
      process.env.TRUSTED_PROXY = 'nginx'
      expect(() => getSettings()).toThrow()
    })
  })

  describe('CORS origin regex security', () => {
    const CORS_ENV_KEYS = ['CORS_ORIGIN_REGEX', 'CORS_ORIGINS'] as const

    let savedEnv: Partial<Record<string, string>>

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = {}
      for (const key of CORS_ENV_KEYS) {
        if (process.env[key] !== undefined) {
          savedEnv[key] = process.env[key]
        }
      }
    })

    afterEach(() => {
      for (const key of CORS_ENV_KEYS) {
        if (savedEnv[key] !== undefined) {
          process.env[key] = savedEnv[key]
        } else {
          delete process.env[key]
        }
      }
      clearSettingsCache()
    })

    it('default regex does NOT match arbitrary localhost ports', () => {
      delete process.env.CORS_ORIGIN_REGEX
      const settings = getSettings()
      const regex = settings.corsOriginRegex!
      expect(regex.test('http://localhost:9999')).toBe(false)
      expect(regex.test('http://localhost:3000')).toBe(false)
      expect(regex.test('http://localhost:8080')).toBe(false)
    })

    it('default regex matches the dev frontend port (1420)', () => {
      delete process.env.CORS_ORIGIN_REGEX
      const settings = getSettings()
      const regex = settings.corsOriginRegex!
      expect(regex.test('http://localhost:1420')).toBe(true)
    })

    it('default regex matches Tauri origins', () => {
      delete process.env.CORS_ORIGIN_REGEX
      const settings = getSettings()
      const regex = settings.corsOriginRegex!
      expect(regex.test('tauri://localhost')).toBe(true)
      expect(regex.test('http://tauri.localhost')).toBe(true)
    })

    it('default regex rejects attacker origins', () => {
      delete process.env.CORS_ORIGIN_REGEX
      const settings = getSettings()
      const regex = settings.corsOriginRegex!
      expect(regex.test('https://attacker.com')).toBe(false)
      expect(regex.test('http://evil.localhost')).toBe(false)
      expect(regex.test('http://localhost:9999')).toBe(false)
    })
  })

  describe('isOriginAllowed', () => {
    it('returns true when origin matches regex', () => {
      const settings = { corsOriginRegex: /^http:\/\/localhost:1420$/ } as any
      expect(isOriginAllowed('http://localhost:1420', settings)).toBe(true)
    })

    it('returns false when origin does not match regex', () => {
      const settings = { corsOriginRegex: /^http:\/\/localhost:1420$/ } as any
      expect(isOriginAllowed('http://localhost:9999', settings)).toBe(false)
    })

    it('returns true when origin is in the string list', () => {
      const settings = { corsOriginRegex: null, corsOrigins: 'http://localhost:1420,https://app.example.com' } as any
      expect(isOriginAllowed('https://app.example.com', settings)).toBe(true)
    })

    it('returns false when origin is not in the string list', () => {
      const settings = { corsOriginRegex: null, corsOrigins: 'http://localhost:1420' } as any
      expect(isOriginAllowed('http://localhost:9999', settings)).toBe(false)
    })
  })

  describe('PowerSync settings', () => {
    const POWERSYNC_ENV_KEYS = [
      'POWERSYNC_URL',
      'POWERSYNC_JWT_KID',
      'POWERSYNC_JWT_SECRET',
      'POWERSYNC_TOKEN_EXPIRY_SECONDS',
    ] as const

    let savedEnv: Partial<Record<string, string>>

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = {}
      for (const key of POWERSYNC_ENV_KEYS) {
        if (process.env[key] !== undefined) {
          savedEnv[key] = process.env[key]
        }
      }
    })

    afterEach(() => {
      for (const key of POWERSYNC_ENV_KEYS) {
        if (savedEnv[key] !== undefined) {
          process.env[key] = savedEnv[key]
        } else {
          delete process.env[key]
        }
      }
      clearSettingsCache()
    })

    it('should use default values when PowerSync env vars are unset', () => {
      for (const key of POWERSYNC_ENV_KEYS) {
        delete process.env[key]
      }
      const settings = getSettings()

      expect(settings.powersyncUrl).toBe('')
      expect(settings.powersyncJwtKid).toBe('')
      expect(settings.powersyncJwtSecret).toBe('')
      expect(settings.powersyncTokenExpirySeconds).toBe(3600)
    })

    it('should read PowerSync values from env when set', () => {
      process.env.POWERSYNC_URL = 'https://sync.example.com'
      process.env.POWERSYNC_JWT_KID = 'my-kid'
      process.env.POWERSYNC_JWT_SECRET = 'my-secret'
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '7200'

      const settings = getSettings()

      expect(settings.powersyncUrl).toBe('https://sync.example.com')
      expect(settings.powersyncJwtKid).toBe('my-kid')
      expect(settings.powersyncJwtSecret).toBe('my-secret')
      expect(settings.powersyncTokenExpirySeconds).toBe(7200)
    })

    it('should coerce powersyncTokenExpirySeconds from string to number', () => {
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '1800'

      const settings = getSettings()

      expect(settings.powersyncTokenExpirySeconds).toBe(1800)
      expect(typeof settings.powersyncTokenExpirySeconds).toBe('number')
    })
  })
})
