import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp } from '../src/index'

describe('Authentication Routes', () => {
  let app: any

  beforeAll(async () => {
    app = await createApp()
  })

  afterAll(async () => {
    // Cleanup if needed
  })

  describe('Google OAuth', () => {
    it('should return Google OAuth config', async () => {
      const response = await app.handle(new Request('http://localhost/auth/google/config'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toHaveProperty('client_id')
    })

    it('should require valid body for token exchange', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/google/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(400)
    })

    it('should require valid body for token refresh', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/google/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(400)
    })
  })

  describe('Microsoft OAuth', () => {
    it('should return Microsoft OAuth config', async () => {
      const response = await app.handle(new Request('http://localhost/auth/microsoft/config'))
      expect(response.status).toBe(200)

      const data = await response.json()
      expect(data).toHaveProperty('client_id')
      expect(data).toHaveProperty('configured')
    })

    it('should require valid body for token exchange', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(400)
    })

    it('should require valid body for token refresh', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(400)
    })
  })
})
