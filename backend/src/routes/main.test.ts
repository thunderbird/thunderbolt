import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { createApp } from '..'
import * as settingsModule from '../config/settings'

describe('Main Routes', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let fetchSpy: ReturnType<typeof spyOn>
  let getSettingsSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    // Mock console methods to reduce test noise
    spyOn(console, 'log').mockImplementation(() => {})
    spyOn(console, 'info').mockImplementation(() => {})
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})

    // Mock fetch for geocoding API
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.startsWith('https://geocoding-api.open-meteo.com')) {
        return new Response(
          JSON.stringify({
            results: [{ name: 'London', admin1: 'England', country: 'UK', latitude: 51.5, longitude: -0.12 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch)

    // Mock settings for analytics route
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      fireworksApiKey: 'test-api-key',
      flowerMgmtKey: '',
      flowerProjId: '',
      exaApiKey: '',
      monitoringToken: '',
      googleClientId: '',
      googleClientSecret: '',
      microsoftClientId: '',
      microsoftClientSecret: '',
      logLevel: 'INFO',
      port: 8000,
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: 'ph_test',
      corsOrigins: 'http://localhost:1420',
      corsOriginRegex: '',
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders:
        'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With',
      corsExposeHeaders: 'mcp-session-id',
    } as any)

    app = await createApp()
  })

  afterAll(async () => {
    // Cleanup if needed
    fetchSpy?.mockRestore()
    getSettingsSpy?.mockRestore()
  })

  it('should return health status', async () => {
    const response = await app.handle(new Request('http://localhost/v1/health'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toEqual({ status: 'ok' })
  })

  it('should return posthog config', async () => {
    const response = await app.handle(new Request('http://localhost/v1/posthog/config'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('posthog_api_key')
  })

  it('should require query parameter for locations endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/v1/locations'))
    expect(response.status).toBe(400) // Global error handler coerces to 400
  })

  it('should search locations with valid query', async () => {
    const response = await app.handle(new Request('http://localhost/v1/locations?query=London'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
  })
})
