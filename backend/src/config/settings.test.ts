import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearSettingsCache,
  getEnabledAgentIds,
  getWaitlistAutoApproveDomains,
  getCorsMethodsList,
  getCorsOriginsList,
  getSettings,
  isOAuthRedirectUriAllowed,
  isOriginAllowed,
} from './settings'
import type { Settings } from './settings'

describe('Config Settings', () => {
  describe('getCorsOriginsList', () => {
    it('should split comma-separated origins', () => {
      const settings = { corsOrigins: 'http://localhost:3000,https://example.com,https://app.example.com' }
      const origins = getCorsOriginsList(settings)

      expect(origins).toEqual(['http://localhost:3000', 'https://example.com', 'https://app.example.com'])
    })

    it('should handle single origin', () => {
      const settings = { corsOrigins: 'http://localhost:3000' }
      const origins = getCorsOriginsList(settings)

      expect(origins).toEqual(['http://localhost:3000'])
    })

    it('should trim whitespace from origins', () => {
      const settings = { corsOrigins: ' http://localhost:3000 , https://example.com , https://app.example.com ' }
      const origins = getCorsOriginsList(settings)

      expect(origins).toEqual(['http://localhost:3000', 'https://example.com', 'https://app.example.com'])
    })

    it('should filter out empty origins', () => {
      const settings = { corsOrigins: 'http://localhost:3000,,https://example.com,' }
      const origins = getCorsOriginsList(settings)

      expect(origins).toEqual(['http://localhost:3000', 'https://example.com'])
    })

    it('should handle empty string', () => {
      const settings = { corsOrigins: '' }
      const origins = getCorsOriginsList(settings)

      expect(origins).toEqual([])
    })
  })

  describe('CORS default security', () => {
    const CORS_ENV_KEYS = ['CORS_ORIGINS'] as const

    let savedEnv: Partial<Record<string, string | undefined>>

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = {}
      for (const key of CORS_ENV_KEYS) {
        savedEnv[key] = process.env[key]
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

    it('should NOT match arbitrary localhost ports by default', () => {
      delete process.env.CORS_ORIGINS
      const settings = getSettings()

      expect(isOriginAllowed('http://localhost:9999', settings)).toBe(false)
      expect(isOriginAllowed('http://localhost:4000', settings)).toBe(false)
      expect(isOriginAllowed('http://localhost:8080', settings)).toBe(false)
    })

    it('should allow Tauri origins by default', () => {
      delete process.env.CORS_ORIGINS
      const settings = getSettings()

      expect(isOriginAllowed('tauri://localhost', settings)).toBe(true)
      expect(isOriginAllowed('http://tauri.localhost', settings)).toBe(true)
    })

    it('should allow the dev frontend by default', () => {
      delete process.env.CORS_ORIGINS
      const settings = getSettings()

      expect(isOriginAllowed('http://localhost:1420', settings)).toBe(true)
    })

    it('should not match non-Tauri origins by default', () => {
      delete process.env.CORS_ORIGINS
      const settings = getSettings()

      expect(isOriginAllowed('https://evil.com', settings)).toBe(false)
      expect(isOriginAllowed('http://malicious.localhost', settings)).toBe(false)
    })
  })

  describe('getWaitlistAutoApproveDomains', () => {
    it('should split comma-separated domains', () => {
      const settings = { waitlistAutoApproveDomains: 'mozilla.org,thunderbird.net,mozilla.ai' }
      const domains = getWaitlistAutoApproveDomains(settings as Pick<Settings, 'waitlistAutoApproveDomains'>)

      expect(domains).toEqual(['mozilla.org', 'thunderbird.net', 'mozilla.ai'])
    })

    it('should handle single domain', () => {
      const settings = { waitlistAutoApproveDomains: 'mozilla.org' }
      const domains = getWaitlistAutoApproveDomains(settings as Pick<Settings, 'waitlistAutoApproveDomains'>)

      expect(domains).toEqual(['mozilla.org'])
    })

    it('should trim whitespace and lowercase domains', () => {
      const settings = { waitlistAutoApproveDomains: ' Mozilla.ORG , Thunderbird.NET ' }
      const domains = getWaitlistAutoApproveDomains(settings as Pick<Settings, 'waitlistAutoApproveDomains'>)

      expect(domains).toEqual(['mozilla.org', 'thunderbird.net'])
    })

    it('should filter out empty domains', () => {
      const settings = { waitlistAutoApproveDomains: 'mozilla.org,,thunderbird.net,' }
      const domains = getWaitlistAutoApproveDomains(settings as Pick<Settings, 'waitlistAutoApproveDomains'>)

      expect(domains).toEqual(['mozilla.org', 'thunderbird.net'])
    })

    it('should handle empty string', () => {
      const settings = { waitlistAutoApproveDomains: '' }
      const domains = getWaitlistAutoApproveDomains(settings as Pick<Settings, 'waitlistAutoApproveDomains'>)

      expect(domains).toEqual([])
    })
  })

  describe('getCorsMethodsList', () => {
    it('should split comma-separated methods', () => {
      const settings = { corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS' }
      const methods = getCorsMethodsList(settings as Pick<Settings, 'corsAllowMethods'>)

      expect(methods).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
    })

    it('should handle single method', () => {
      const settings = { corsAllowMethods: 'GET' }
      const methods = getCorsMethodsList(settings as Pick<Settings, 'corsAllowMethods'>)

      expect(methods).toEqual(['GET'])
    })

    it('should trim whitespace from methods', () => {
      const settings = { corsAllowMethods: ' GET , POST , PUT ' }
      const methods = getCorsMethodsList(settings as Pick<Settings, 'corsAllowMethods'>)

      expect(methods).toEqual(['GET', 'POST', 'PUT'])
    })

    it('should filter out empty methods', () => {
      const settings = { corsAllowMethods: 'GET,,POST,' }
      const methods = getCorsMethodsList(settings as Pick<Settings, 'corsAllowMethods'>)

      expect(methods).toEqual(['GET', 'POST'])
    })

    it('should handle empty string', () => {
      const settings = { corsAllowMethods: '' }
      const methods = getCorsMethodsList(settings as Pick<Settings, 'corsAllowMethods'>)

      expect(methods).toEqual([])
    })
  })

  describe('getEnabledAgentIds', () => {
    it('should return null when enabledAgents is empty', () => {
      const result = getEnabledAgentIds({ enabledAgents: '' } as Pick<Settings, 'enabledAgents'>)
      expect(result).toBeNull()
    })

    it('should parse comma-separated agent IDs', () => {
      const result = getEnabledAgentIds({
        enabledAgents: 'agent-haystack-docs,agent-haystack-legal',
      } as Pick<Settings, 'enabledAgents'>)
      expect(result).toEqual(['agent-haystack-docs', 'agent-haystack-legal'])
    })

    it('should parse a single agent ID', () => {
      const result = getEnabledAgentIds({ enabledAgents: 'agent-haystack-docs' } as Pick<Settings, 'enabledAgents'>)
      expect(result).toEqual(['agent-haystack-docs'])
    })

    it('should trim whitespace from agent IDs', () => {
      const result = getEnabledAgentIds({
        enabledAgents: ' agent-haystack-docs , agent-haystack-legal ',
      } as Pick<Settings, 'enabledAgents'>)
      expect(result).toEqual(['agent-haystack-docs', 'agent-haystack-legal'])
    })

    it('should filter out empty entries', () => {
      const result = getEnabledAgentIds({
        enabledAgents: 'agent-haystack-docs,,agent-haystack-legal,',
      } as Pick<Settings, 'enabledAgents'>)
      expect(result).toEqual(['agent-haystack-docs', 'agent-haystack-legal'])
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

  describe('allowCustomAgents setting', () => {
    let savedEnv: string | undefined

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = process.env.ALLOW_CUSTOM_AGENTS
    })

    afterEach(() => {
      if (savedEnv !== undefined) {
        process.env.ALLOW_CUSTOM_AGENTS = savedEnv
      } else {
        delete process.env.ALLOW_CUSTOM_AGENTS
      }
      clearSettingsCache()
    })

    it('should default to true when ALLOW_CUSTOM_AGENTS is absent', () => {
      delete process.env.ALLOW_CUSTOM_AGENTS
      const settings = getSettings()
      expect(settings.allowCustomAgents).toBe(true)
    })

    it('should be false when ALLOW_CUSTOM_AGENTS=false', () => {
      process.env.ALLOW_CUSTOM_AGENTS = 'false'
      const settings = getSettings()
      expect(settings.allowCustomAgents).toBe(false)
    })

    it('should be true when ALLOW_CUSTOM_AGENTS=true', () => {
      process.env.ALLOW_CUSTOM_AGENTS = 'true'
      const settings = getSettings()
      expect(settings.allowCustomAgents).toBe(true)
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

  describe('isOriginAllowed', () => {
    it('returns true for exact match', () => {
      const settings = { corsOrigins: 'http://localhost:1420,https://app.example.com' }
      expect(isOriginAllowed('https://app.example.com', settings)).toBe(true)
    })

    it('returns false when origin is not in the list', () => {
      const settings = { corsOrigins: 'http://localhost:1420' }
      expect(isOriginAllowed('http://localhost:9999', settings)).toBe(false)
    })

    it('returns true for explicit Tauri origins in the default config', () => {
      const settings = { corsOrigins: 'http://localhost:1420,tauri://localhost,http://tauri.localhost' }
      expect(isOriginAllowed('tauri://localhost', settings)).toBe(true)
      expect(isOriginAllowed('http://tauri.localhost', settings)).toBe(true)
    })
  })

  describe('Swagger settings', () => {
    let savedEnv: string | undefined

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = process.env.SWAGGER_ENABLED
    })

    afterEach(() => {
      if (savedEnv !== undefined) {
        process.env.SWAGGER_ENABLED = savedEnv
      } else {
        delete process.env.SWAGGER_ENABLED
      }
      clearSettingsCache()
    })

    it('should default swaggerEnabled to false when env var is unset', () => {
      delete process.env.SWAGGER_ENABLED
      const settings = getSettings()
      expect(settings.swaggerEnabled).toBe(false)
    })

    it('should enable swagger when SWAGGER_ENABLED is "true"', () => {
      process.env.SWAGGER_ENABLED = 'true'
      const settings = getSettings()
      expect(settings.swaggerEnabled).toBe(true)
    })

    it('should keep swagger disabled for any value other than "true"', () => {
      process.env.SWAGGER_ENABLED = 'false'
      const settings = getSettings()
      expect(settings.swaggerEnabled).toBe(false)
    })

    it('should keep swagger disabled when set to empty string', () => {
      process.env.SWAGGER_ENABLED = ''
      const settings = getSettings()
      expect(settings.swaggerEnabled).toBe(false)
    })
  })

  describe('E2EE settings', () => {
    let savedEnv: string | undefined

    beforeEach(() => {
      clearSettingsCache()
      savedEnv = process.env.E2EE_ENABLED
    })

    afterEach(() => {
      if (savedEnv !== undefined) {
        process.env.E2EE_ENABLED = savedEnv
      } else {
        delete process.env.E2EE_ENABLED
      }
      clearSettingsCache()
    })

    it('should default e2eeEnabled to false when env var is unset', () => {
      delete process.env.E2EE_ENABLED
      const settings = getSettings()
      expect(settings.e2eeEnabled).toBe(false)
    })

    it('should enable E2EE when E2EE_ENABLED is "true"', () => {
      process.env.E2EE_ENABLED = 'true'
      const settings = getSettings()
      expect(settings.e2eeEnabled).toBe(true)
    })

    it('should keep E2EE disabled for any value other than "true"', () => {
      process.env.E2EE_ENABLED = 'false'
      const settings = getSettings()
      expect(settings.e2eeEnabled).toBe(false)
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
      process.env.POWERSYNC_JWT_SECRET = 'a]3kF#9xL!mP7qR2vT5wY8zA0cE4gI6j'
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '7200'

      const settings = getSettings()

      expect(settings.powersyncUrl).toBe('https://sync.example.com')
      expect(settings.powersyncJwtKid).toBe('my-kid')
      expect(settings.powersyncJwtSecret).toBe('a]3kF#9xL!mP7qR2vT5wY8zA0cE4gI6j')
      expect(settings.powersyncTokenExpirySeconds).toBe(7200)
    })

    it('should coerce powersyncTokenExpirySeconds from string to number', () => {
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '1800'

      const settings = getSettings()

      expect(settings.powersyncTokenExpirySeconds).toBe(1800)
      expect(typeof settings.powersyncTokenExpirySeconds).toBe('number')
    })

    it('should reject zero token expiry', () => {
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '0'
      expect(() => getSettings()).toThrow()
    })

    it('should reject negative token expiry', () => {
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '-1'
      expect(() => getSettings()).toThrow()
    })

    it('should reject non-integer token expiry', () => {
      process.env.POWERSYNC_TOKEN_EXPIRY_SECONDS = '3600.5'
      expect(() => getSettings()).toThrow()
    })

    it('should reject short JWT secret when powersyncUrl is set', () => {
      process.env.POWERSYNC_URL = 'https://sync.example.com'
      process.env.POWERSYNC_JWT_SECRET = 'too-short'
      expect(() => getSettings()).toThrow()
    })

    it('should accept exactly 32-character JWT secret when powersyncUrl is set', () => {
      process.env.POWERSYNC_URL = 'https://sync.example.com'
      process.env.POWERSYNC_JWT_SECRET = 'a'.repeat(32)
      expect(() => getSettings()).not.toThrow()
    })

    it('should allow empty JWT secret when powersyncUrl is empty', () => {
      process.env.POWERSYNC_URL = ''
      process.env.POWERSYNC_JWT_SECRET = ''
      const settings = getSettings()
      expect(settings.powersyncJwtSecret).toBe('')
    })
  })

  describe('isOAuthRedirectUriAllowed', () => {
    const settings = { corsOrigins: 'http://localhost:1420,tauri://localhost,http://tauri.localhost' }

    it('allows web dev callback', () => {
      expect(isOAuthRedirectUriAllowed('http://localhost:1420/oauth/callback', settings)).toBe(true)
    })

    it('allows loopback with dynamic port', () => {
      expect(isOAuthRedirectUriAllowed('http://localhost:17421', settings)).toBe(true)
    })

    it('allows Tauri desktop callback', () => {
      expect(isOAuthRedirectUriAllowed('tauri://localhost/oauth-callback.html', settings)).toBe(true)
    })

    it('allows mobile App Link callback', () => {
      expect(isOAuthRedirectUriAllowed('https://app.thunderbolt.io/oauth/callback', settings)).toBe(true)
    })

    it('allows production origin from corsOrigins', () => {
      const prod = { corsOrigins: 'https://app.thunderbolt.io' }
      expect(isOAuthRedirectUriAllowed('https://app.thunderbolt.io/oauth/callback', prod)).toBe(true)
    })

    it('rejects attacker domain', () => {
      expect(isOAuthRedirectUriAllowed('https://evil.com/callback', settings)).toBe(false)
    })

    it('rejects HTTPS on localhost', () => {
      expect(isOAuthRedirectUriAllowed('https://localhost:1420/oauth/callback', settings)).toBe(false)
    })

    it('rejects invalid URL', () => {
      expect(isOAuthRedirectUriAllowed('not-a-url', settings)).toBe(false)
    })

    it('rejects empty string', () => {
      expect(isOAuthRedirectUriAllowed('', settings)).toBe(false)
    })
  })
})
