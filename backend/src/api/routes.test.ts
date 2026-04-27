import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createMainRoutes } from './routes'

describe('Main Routes', () => {
  let app: ReturnType<typeof createMainRoutes>
  let consoleSpies: ConsoleSpies

  const mockFetch = mock((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const { hostname } = new URL(url)
    if (hostname === 'geocoding-api.open-meteo.com') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [{ name: 'London', admin1: 'England', country: 'UK', latitude: 51.5, longitude: -0.12 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  })

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    app = createMainRoutes(mockAuth, mockFetch as unknown as typeof fetch)
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  describe('auth guard', () => {
    let unauthApp: ReturnType<typeof createMainRoutes>

    beforeAll(() => {
      unauthApp = createMainRoutes(mockAuthUnauthenticated, mockFetch as unknown as typeof fetch)
    })

    it('should allow unauthenticated requests to /health', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/health'))
      expect(response.status).toBe(200)
    })

    it('should reject unauthenticated requests to /units', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/units?country=US'))
      expect(response.status).toBe(401)
    })

    it('should reject unauthenticated requests to /units-options', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/units-options'))
      expect(response.status).toBe(401)
    })

    it('should reject unauthenticated requests to /locations', async () => {
      const response = await unauthApp.handle(new Request('http://localhost/locations?query=London'))
      expect(response.status).toBe(401)
    })
  })

  it('should return health status', async () => {
    const response = await app.handle(new Request('http://localhost/health'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toEqual({ status: 'ok' })
  })

  it('should require query parameter for locations endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/locations'))
    expect(response.status).toBe(422) // Elysia validation error
  })

  it('should search locations with valid query', async () => {
    const response = await app.handle(new Request('http://localhost/locations?query=London'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
  })

  it('should filter out country-level results without admin1', async () => {
    const mockFetchWithCountry = mock((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      const { hostname } = new URL(url)
      if (hostname === 'geocoding-api.open-meteo.com') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { name: 'Canada', country: 'Canada', latitude: 60.1, longitude: -113.6 },
                { name: 'Canada', admin1: 'Kentucky', country: 'United States', latitude: 37.6, longitude: -82.3 },
                { name: 'Cañada', admin1: 'Valencia', country: 'Spain', latitude: 38.7, longitude: -0.8 },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })

    const testApp = createMainRoutes(mockAuth, mockFetchWithCountry as unknown as typeof fetch)

    const response = await testApp.handle(new Request('http://localhost/locations?query=Canada'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(2)
    expect(data.every((loc: { region: string }) => loc.region !== '')).toBe(true)
    expect(data).toEqual([
      { name: 'Canada', region: 'Kentucky', country: 'United States', lat: 37.6, lon: -82.3 },
      { name: 'Cañada', region: 'Valencia', country: 'Spain', lat: 38.7, lon: -0.8 },
    ])
  })

  describe('Units routes', () => {
    it('should require country parameter for units endpoint', async () => {
      const response = await app.handle(new Request('http://localhost/units'))
      expect(response.status).toBe(422) // Elysia validation error
    })

    it('should return units data for valid country code (Brazil)', async () => {
      const response = await app.handle(new Request('http://localhost/units?country=BR'))
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
      const response = await app.handle(new Request('http://localhost/units?country=Brazil'))
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
      const response = await app.handle(new Request('http://localhost/units?country=US'))
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
      const response = await app.handle(new Request('http://localhost/units?country=United States'))
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
      const response = await app.handle(new Request('http://localhost/units?country=INVALID'))
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
      const response = await app.handle(new Request('http://localhost/units?country='))
      expect(response.status).toBe(400)

      const data = await response.json()
      expect(data).toEqual({
        success: false,
        data: null,
        error: 'Bad Request',
      })
    })

    it('should return units-options data', async () => {
      const response = await app.handle(new Request('http://localhost/units-options'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toHaveProperty('units')
      expect(data).toHaveProperty('temperature')
      expect(data).toHaveProperty('timeFormat')
      expect(data).toHaveProperty('dateFormats')
      expect(data).toHaveProperty('currencies')

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
