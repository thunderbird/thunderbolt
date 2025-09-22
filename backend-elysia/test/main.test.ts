import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp } from '../src/index'

describe('Main Routes', () => {
  let app: any

  beforeAll(async () => {
    app = await createApp()
  })

  afterAll(async () => {
    // Cleanup if needed
  })

  it('should return health status', async () => {
    const response = await app.handle(new Request('http://localhost/health'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toEqual({ status: 'ok' })
  })

  it('should return analytics config', async () => {
    const response = await app.handle(new Request('http://localhost/analytics/config'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(data).toHaveProperty('posthog_api_key')
  })

  it('should require query parameter for locations endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/locations'))
    expect(response.status).toBe(400)
  })

  it('should search locations with valid query', async () => {
    const response = await app.handle(new Request('http://localhost/locations?query=London'))
    expect(response.status).toBe(200)

    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
  })
})
