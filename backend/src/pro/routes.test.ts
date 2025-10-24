import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { createProToolsRoutes } from './routes'

describe('Pro Tools Routes', () => {
  let app: ReturnType<typeof createProToolsRoutes>
  let mockFetch: ReturnType<typeof mock>

  const createMockWeatherResponse = (body: any = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  beforeAll(async () => {
    // Mock console methods to reduce test noise
    spyOn(console, 'log').mockImplementation(() => {})
    spyOn(console, 'info').mockImplementation(() => {})
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})

    // Create mock fetch for weather API calls
    mockFetch = mock((url: string) => {
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
              wind_speed_10m: 10,
              relative_humidity_2m: 70,
            },
            daily: {
              time: ['2025-10-24', '2025-10-25', '2025-10-26'],
              temperature_2m_max: [18, 19, 17],
              temperature_2m_min: [12, 13, 11],
            },
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    app = createProToolsRoutes(mockFetch as unknown as typeof fetch)
  })

  afterAll(async () => {
    // Cleanup if needed
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
