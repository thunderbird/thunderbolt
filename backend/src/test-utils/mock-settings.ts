import type { Settings } from '@/config/settings'

/**
 * Default mock settings for testing
 * Use this as a base and override specific values as needed
 */
export const createMockSettings = (overrides: Partial<Settings> = {}): Settings => ({
  fireworksApiKey: 'test-api-key',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  logLevel: 'INFO',
  port: 8000,
  posthogHost: 'https://us.i.posthog.com',
  posthogApiKey: 'ph_test',
  langsmithApiKey: '',
  langsmithProject: 'thunderbolt-test',
  langsmithTracingEnabled: false,
  langsmithSamplingRate: 1.0,
  heliconeApiKey: '',
  corsOrigins: 'http://localhost:1420',
  corsOriginRegex: '',
  corsAllowCredentials: true,
  corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
  corsAllowHeaders:
    'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With',
  corsExposeHeaders: 'mcp-session-id',
  ...overrides,
})
