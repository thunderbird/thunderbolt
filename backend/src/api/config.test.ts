import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import type { Settings } from '@/config/settings'
import { createConfigRoutes } from './config'

describe('Config Routes', () => {
  describe('GET /config', () => {
    it('returns e2eeEnabled: false when disabled', async () => {
      const app = new Elysia().use(createConfigRoutes({ e2eeEnabled: false } as Settings))

      const response = await app.handle(new Request('http://localhost/config'))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ e2eeEnabled: false })
    })

    it('returns e2eeEnabled: true when enabled', async () => {
      const app = new Elysia().use(createConfigRoutes({ e2eeEnabled: true } as Settings))

      const response = await app.handle(new Request('http://localhost/config'))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ e2eeEnabled: true })
    })

    it('does not require authentication', async () => {
      const app = new Elysia().use(createConfigRoutes({ e2eeEnabled: false } as Settings))

      const response = await app.handle(new Request('http://localhost/config'))

      expect(response.status).toBe(200)
    })
  })
})
