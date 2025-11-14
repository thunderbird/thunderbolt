import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { createProToolsRoutes } from './routes'

describe('Pro Tools Routes', () => {
  let app: ReturnType<typeof createProToolsRoutes>
  let mockFetch: ReturnType<typeof mock>
  let consoleLogSpy: ReturnType<typeof spyOn>
  let consoleInfoSpy: ReturnType<typeof spyOn>
  let consoleErrorSpy: ReturnType<typeof spyOn>
  let consoleWarnSpy: ReturnType<typeof spyOn>

  const createMockWeatherResponse = (body: any = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  beforeAll(async () => {
    // Mock console methods to reduce test noise
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
    consoleInfoSpy = spyOn(console, 'info').mockImplementation(() => {})
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    // Create mock fetch for weather API calls
    mockFetch = mock((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('geocoding-api.open-meteo.com')) {
        return Promise.resolve(
          createMockWeatherResponse({
            results: [
              {
                name: 'London',
                latitude: 51.5074,
                longitude: -0.1278,
                admin1: 'England',
                country: 'United Kingdom',
                elevation: 11,
              },
            ],
          }),
        )
      }
      if (url.includes('api.open-meteo.com')) {
        return Promise.resolve(
          createMockWeatherResponse({
            current: {
              temperature_2m: 15,
              relative_humidity_2m: 70,
              apparent_temperature: 14,
              weather_code: 0,
              wind_speed_10m: 10,
              wind_direction_10m: 180,
              time: '2025-10-24T12:00',
            },
            current_units: {
              temperature_2m: '°C',
              relative_humidity_2m: '%',
              apparent_temperature: '°C',
              wind_speed_10m: 'km/h',
              wind_direction_10m: '°',
            },
            daily: {
              time: ['2025-10-24', '2025-10-25', '2025-10-26'],
              weather_code: [0, 1, 2],
              temperature_2m_max: [18, 19, 17],
              temperature_2m_min: [12, 13, 11],
              apparent_temperature_max: [17, 18, 16],
              apparent_temperature_min: [11, 12, 10],
              precipitation_sum: [0, 2.5, 5.0],
              precipitation_probability_max: [10, 60, 80],
              wind_speed_10m_max: [15, 20, 25],
            },
            daily_units: {
              temperature_2m_max: '°C',
              temperature_2m_min: '°C',
              apparent_temperature_max: '°C',
              apparent_temperature_min: '°C',
              precipitation_sum: 'mm',
              precipitation_probability_max: '%',
              wind_speed_10m_max: 'km/h',
            },
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    app = createProToolsRoutes(mockFetch as unknown as typeof fetch)
  })

  afterAll(async () => {
    consoleLogSpy?.mockRestore()
    consoleInfoSpy?.mockRestore()
    consoleErrorSpy?.mockRestore()
    consoleWarnSpy?.mockRestore()
  })

  it('should return error when search API key is not configured', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test search', max_results: 5 }),
      }),
    )

    expect(response.status).toBe(500)
    const data = await response.json()
    expect(data).toEqual({
      success: false,
      data: null,
      error: 'Search service is not configured.',
    })
  })

  it('should return error when fetch-content API key is not configured', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      }),
    )

    expect(response.status).toBe(500)
    const data = await response.json()
    expect(data).toEqual({
      success: false,
      data: null,
      error: 'Fetch content service is not configured.',
    })
  })

  it('should handle current weather request', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/weather/current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: 'London', region: 'England', country: 'United Kingdom' }),
      }),
    )
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('data')
  })

  it('should handle weather forecast request', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/weather/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: 'London', region: 'England', country: 'United Kingdom', days: 3 }),
      }),
    )
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('data')
  })

  it('should handle location search request', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/locations/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'London', region: 'England', country: 'United Kingdom' }),
      }),
    )
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('data')
  })

  it('should require valid body for requests', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(response.status).toBe(400) // Validation error
    const data = await response.json()
    expect(data).toHaveProperty('success', false)
    expect(data).toHaveProperty('data', null)
    expect(data).toHaveProperty('error')
  })
})
