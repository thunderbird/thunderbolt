import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createProToolsRoutes } from './routes'

describe('Pro Tools Routes', () => {
  let app: Elysia

  beforeAll(async () => {
    // Mock console methods to reduce test noise
    spyOn(console, 'log').mockImplementation(() => {})
    spyOn(console, 'info').mockImplementation(() => {})
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})

    app = new Elysia().use(createProToolsRoutes())
  })

  afterAll(async () => {
    // Cleanup if needed
  })

  it('should handle search request without API key', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test search', max_results: 5 }),
      }),
    )
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('data')
    // Check if search succeeded or failed (depends on API key configuration)
    if (data.success) {
      expect(data.data).toBeDefined()
    } else {
      expect(data).toHaveProperty('error')
    }
  })

  it('should handle fetch-content request without API key', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.com'] }),
      }),
    )
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('data')
    // Check if fetch succeeded or failed (depends on API key configuration)
    if (data.success) {
      expect(data.data).toBeDefined()
    } else {
      expect(data).toHaveProperty('error')
    }
  })

  it('should handle current weather request', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/weather/current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: 'London' }),
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
        body: JSON.stringify({ location: 'London', days: 3 }),
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
        body: JSON.stringify({ query: 'London' }),
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
    expect(response.status).toBe(422) // Validation error when not using global error handler
  })
})
