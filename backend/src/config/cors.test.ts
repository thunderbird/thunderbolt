/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createCorsMiddleware } from '@/config/cors'
import { getCorsOriginsList } from '@/config/settings'
import { Elysia } from 'elysia'

/**
 * Integration tests for CORS middleware behavior.
 * Verifies that the actual HTTP headers are set correctly for various origins.
 */
describe('CORS integration', () => {
  const createTestApp = (corsOrigins: string[], corsAllowCredentials = true) =>
    new Elysia()
      .use(
        createCorsMiddleware({
          corsOrigins: corsOrigins.join(','),
          corsAllowCredentials,
          corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          corsExposeHeaders: '',
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
      expect(res.headers.get('timing-allow-origin')).toBe('https://app.example.com')
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
      expect(res.headers.get('timing-allow-origin')).toBeNull()
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
      expect(res.headers.get('timing-allow-origin')).toBeNull()
    })

    it('should expose timing for preflight from an allowed origin', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://app.example.com',
            'Access-Control-Request-Method': 'DELETE',
          },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      expect(res.headers.get('access-control-max-age')).toBe('600')
      expect(res.headers.get('timing-allow-origin')).toBe('https://app.example.com')
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

  it('echoes the request origin for credentialed wildcard access', async () => {
    const app = createTestApp(['*'])
    const res = await app.handle(
      new Request('http://localhost/test', {
        headers: { Origin: 'https://app.example.com' },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('timing-allow-origin')).toBe('https://app.example.com')
    expect(res.headers.get('vary')).toContain('Origin')
  })

  it('uses wildcard access when credentials are disabled', async () => {
    const app = createTestApp(['*'], false)
    const res = await app.handle(
      new Request('http://localhost/test', {
        headers: { Origin: 'https://app.example.com' },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(res.headers.get('timing-allow-origin')).toBe('*')
  })
})
