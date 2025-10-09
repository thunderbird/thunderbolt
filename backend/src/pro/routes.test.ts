import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { createProToolsRoutes } from './routes'

describe('Pro Tools Routes', () => {
  let app: ReturnType<typeof createProToolsRoutes>

  beforeAll(async () => {
    // Mock console methods to reduce test noise
    spyOn(console, 'log').mockImplementation(() => {})
    spyOn(console, 'info').mockImplementation(() => {})
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})

    app = createProToolsRoutes()
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
