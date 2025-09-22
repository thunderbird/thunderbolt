import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp } from '../src/index'

describe('Pro Tools Routes', () => {
  let app: any

  beforeAll(async () => {
    app = await createApp()
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
    expect(data).toHaveProperty('results')
    expect(data).toHaveProperty('error')
  })

  it('should handle fetch-content request without API key', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/fetch-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      }),
    )
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('content')
    expect(data).toHaveProperty('error')
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
    expect(data).toHaveProperty('weather_data')
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
    expect(data).toHaveProperty('weather_data')
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
    expect(data).toHaveProperty('locations')
  })

  it('should require valid body for requests', async () => {
    const response = await app.handle(
      new Request('http://localhost/pro/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(response.status).toBe(400)
  })
})
