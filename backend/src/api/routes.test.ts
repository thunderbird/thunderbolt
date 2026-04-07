import type { Settings } from '@/config/settings'
import * as settingsModule from '@/config/settings'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestDb } from '@/test-utils/db'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createApp } from '../index'

describe('Main Routes', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
  let cleanup: () => Promise<void>

  const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
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
  }

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()

    // Mock settings for analytics route
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
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
      appUrl: 'http://localhost:1420',
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: 'ph_test',
      corsOrigins: 'http://localhost:1420',
      corsOriginRegex: null,
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders:
        'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With',
      corsExposeHeaders: 'mcp-session-id',
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
    } satisfies Settings)
  })

  beforeEach(async () => {
    const testEnv = await createTestDb()
    cleanup = testEnv.cleanup
    app = await createApp({ fetchFn: mockFetch as typeof fetch, database: testEnv.db })
  })

  afterEach(async () => {
    await cleanup()
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
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
    expect(response.status).toBe(422) // Elysia validation error
  })

  it('should search locations with valid query', async () => {
    const response = await app.handle(new Request('http://localhost/v1/locations?query=London'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
  })

  it('should filter out country-level results without admin1', async () => {
    // Mock fetch that returns a mix of city and country results
    const mockFetchWithCountry = async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.startsWith('https://geocoding-api.open-meteo.com')) {
        return new Response(
          JSON.stringify({
            results: [
              // Country-level result (no admin1) - should be filtered out
              { name: 'Canada', country: 'Canada', latitude: 60.1, longitude: -113.6 },
              // City-level result (has admin1) - should be included
              { name: 'Canada', admin1: 'Kentucky', country: 'United States', latitude: 37.6, longitude: -82.3 },
              // Another city with admin1 - should be included
              { name: 'Cañada', admin1: 'Valencia', country: 'Spain', latitude: 38.7, longitude: -0.8 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const testEnv = await createTestDb()
    const testApp = await createApp({ fetchFn: mockFetchWithCountry as typeof fetch, database: testEnv.db })

    const response = await testApp.handle(new Request('http://localhost/v1/locations?query=Canada'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)
    expect(data.every((loc: { region: string }) => loc.region !== '')).toBe(true)
    expect(data).toEqual([
      { name: 'Canada', region: 'Kentucky', country: 'United States', lat: 37.6, lon: -82.3 },
      { name: 'Cañada', region: 'Valencia', country: 'Spain', lat: 38.7, lon: -0.8 },
    ])

    await testEnv.cleanup()
  })

  describe('Units routes', () => {
    it('should require country parameter for units endpoint', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units'))
      expect(response.status).toBe(422) // Elysia validation error
    })

    it('should return units data for valid country code (Brazil)', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units?country=BR'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toEqual({
        unit: 'metric',
        temperature: 'c',
        timeFormat: '24h',
        dateFormatExample: 'DD/MM/YYYY',
        currency: {
          code: 'BRL',
          symbol: 'R$',
          name: 'Brazilian Real',
        },
      })
    })

    it('should return units data for valid country name (Brazil)', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units?country=Brazil'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toEqual({
        unit: 'metric',
        temperature: 'c',
        timeFormat: '24h',
        dateFormatExample: 'DD/MM/YYYY',
        currency: {
          code: 'BRL',
          symbol: 'R$',
          name: 'Brazilian Real',
        },
      })
    })

    it('should return units data for valid country code (United States)', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units?country=US'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toEqual({
        unit: 'imperial',
        temperature: 'f',
        timeFormat: '12h',
        dateFormatExample: 'MM/DD/YYYY',
        currency: {
          code: 'USD',
          symbol: '$',
          name: 'US Dollar',
        },
      })
    })

    it('should return units data for valid country name (United States)', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units?country=United States'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toEqual({
        unit: 'imperial',
        temperature: 'f',
        timeFormat: '12h',
        dateFormatExample: 'MM/DD/YYYY',
        currency: {
          code: 'USD',
          symbol: '$',
          name: 'US Dollar',
        },
      })
    })

    it('should return US data as fallback for invalid country', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units?country=INVALID'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toEqual({
        unit: 'imperial',
        temperature: 'f',
        timeFormat: '12h',
        dateFormatExample: 'MM/DD/YYYY',
        currency: {
          code: 'USD',
          symbol: '$',
          name: 'US Dollar',
        },
      })
    })

    it('should return 400 for empty country parameter', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units?country='))
      expect(response.status).toBe(400)

      // Error handler sanitizes internal error messages for security
      const data = await response.json()
      expect(data).toEqual({
        success: false,
        data: null,
        error: 'Bad Request',
      })
    })

    it('should return units-options data', async () => {
      const response = await app.handle(new Request('http://localhost/v1/units-options'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toHaveProperty('units')
      expect(data).toHaveProperty('temperature')
      expect(data).toHaveProperty('timeFormat')
      expect(data).toHaveProperty('dateFormats')
      expect(data).toHaveProperty('currencies')

      // Verify structure of units options
      expect(Array.isArray(data.units)).toBe(true)
      expect(data.units).toContain('metric')
      expect(data.units).toContain('imperial')

      expect(Array.isArray(data.temperature)).toBe(true)
      expect(data.temperature).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ symbol: 'c', name: 'Celsius' }),
          expect.objectContaining({ symbol: 'f', name: 'Fahrenheit' }),
        ]),
      )

      expect(Array.isArray(data.timeFormat)).toBe(true)
      expect(data.timeFormat).toContain('12h')
      expect(data.timeFormat).toContain('24h')

      expect(Array.isArray(data.dateFormats)).toBe(true)
      expect(data.dateFormats.length).toBeGreaterThan(0)
      expect(data.dateFormats[0]).toHaveProperty('format')
      expect(data.dateFormats[0]).toHaveProperty('example')

      expect(Array.isArray(data.currencies)).toBe(true)
      expect(data.currencies.length).toBeGreaterThan(0)
      expect(data.currencies[0]).toHaveProperty('code')
      expect(data.currencies[0]).toHaveProperty('symbol')
      expect(data.currencies[0]).toHaveProperty('name')
    })
  })
})
