/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getCorsOriginsList } from '@/config/settings'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Integration tests for CORS middleware behavior.
 * Verifies that the actual HTTP headers are set correctly for various origins.
 */
describe('CORS integration', () => {
  const createTestApp = (corsOrigins: string[]) =>
    new Elysia()
      .use(
        cors({
          origin: corsOrigins,
          credentials: true,
          methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          allowedHeaders: 'Content-Type,Authorization',
        }),
      )
      .get('/test', () => ({ ok: true }))
      .delete('/test', () => ({ ok: true }))

  describe('with Tauri and explicit origins', () => {
    const origins = getCorsOriginsList({
      corsOrigins: 'https://app.example.com,tauri://localhost,http://tauri.localhost',
    })

    it('should allow the explicit origin', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://app.example.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should allow tauri://localhost', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'tauri://localhost' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should allow http://tauri.localhost', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://tauri.localhost' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should reject arbitrary localhost ports', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should reject unknown origins', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://evil.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should reject preflight from arbitrary localhost ports', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:9999',
            'Access-Control-Request-Method': 'DELETE',
          },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('with only explicit origins', () => {
    const origins = getCorsOriginsList({
      corsOrigins: 'https://app.example.com',
    })

    it('should allow the explicit origin', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://app.example.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    })

    it('should reject other origins', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })
})
