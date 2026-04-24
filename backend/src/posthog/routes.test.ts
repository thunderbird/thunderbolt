import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createPostHogRoutes } from './routes'
import * as settingsModule from '@/config/settings'

describe('PostHog Proxy Routes', () => {
  let app: { handle: Elysia['handle'] }
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()

    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      fireworksApiKey: '',
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
      appUrl: 'http://localhost:1420',
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: 'test-key',
      corsOrigins: 'http://localhost:1420',
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders: 'Content-Type,Authorization',
      corsExposeHeaders: '',
      waitlistEnabled: false,
      waitlistAutoApproveDomains: '',
      powersyncUrl: '',
      powersyncJwtKid: '',
      powersyncJwtSecret: '',
      powersyncTokenExpirySeconds: 3600,
      authMode: 'consumer' as const,
      oidcClientId: '',
      oidcClientSecret: '',
      oidcIssuer: '',
      betterAuthUrl: 'http://localhost:8000',
      betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
      rateLimitEnabled: false,
      swaggerEnabled: false,
      e2eeEnabled: false,
      trustedProxy: '',
    } as ReturnType<typeof settingsModule.getSettings>)

    mockFetch = mock(() =>
      Promise.resolve(new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json' } })),
    )

    app = new Elysia().use(createPostHogRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockClear()
    consoleSpies.error.mockClear()
  })

  it('adds security headers to prevent XSS via proxied content', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><script>alert("xss")</script></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    )

    const response = await app.handle(new Request('http://localhost/posthog/some/path', { method: 'GET' }))

    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('adds security headers for JSON responses too', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
    )

    const response = await app.handle(new Request('http://localhost/posthog/batch', { method: 'POST' }))

    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
