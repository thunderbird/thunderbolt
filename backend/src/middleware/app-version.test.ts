/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createCorsMiddleware } from '@/config/cors'
import { appVersionExemptPrefixes, createAppVersionMiddleware, isExempt } from './app-version'

const corsSettings = {
  corsOrigins: '*',
  corsAllowCredentials: false,
  corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
  corsExposeHeaders: '',
}

/**
 * Build a tiny app that mirrors production mount order: CORS first (so 426s
 * carry ACAO), then the version gate, then a catch-all route. No DB needed.
 */
const createTestApp = (minAppVersion: string) =>
  new Elysia()
    .use(createCorsMiddleware(corsSettings))
    .use(createAppVersionMiddleware({ minAppVersion }))
    .get('/v1/test', () => ({ ok: true }))
    .get('/*', () => ({ ok: true }))

const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { headers })

describe('app-version gate', () => {
  describe('isExempt helper', () => {
    it('exempts OPTIONS regardless of path', () => {
      expect(isExempt('/v1/inference', 'OPTIONS')).toBe(true)
    })

    it('exempts each configured prefix', () => {
      for (const prefix of appVersionExemptPrefixes) {
        expect(isExempt(prefix, 'GET')).toBe(true)
        expect(isExempt(`${prefix}/nested`, 'GET')).toBe(true)
      }
    })

    it('does not exempt an arbitrary gated path', () => {
      expect(isExempt('/v1/inference', 'GET')).toBe(false)
    })

    it('does not exempt sso lookalikes without the trailing slash', () => {
      expect(isExempt('/v1/api/auth/ssoXYZ', 'GET')).toBe(false)
    })
  })

  describe('enforcement', () => {
    it('returns 426 with the upgrade envelope for a below-min version', async () => {
      const app = createTestApp('0.2.0')

      const response = await app.handle(request('/v1/test', { 'x-app-version': '0.1.0' }))

      expect(response.status).toBe(426)
      const body = await response.json()
      expect(body).toEqual({
        success: false,
        data: null,
        error: 'Upgrade Required',
        code: 'APP_VERSION_UNSUPPORTED',
        minAppVersion: '0.2.0',
      })
    })

    it('allows a version equal to the minimum', async () => {
      const app = createTestApp('0.2.0')

      const response = await app.handle(request('/v1/test', { 'x-app-version': '0.2.0' }))

      expect(response.status).toBe(200)
    })

    it('allows a version above the minimum', async () => {
      const app = createTestApp('0.2.0')

      const response = await app.handle(request('/v1/test', { 'x-app-version': '1.0.0' }))

      expect(response.status).toBe(200)
    })

    it('fails closed with 426 when the header is missing', async () => {
      const app = createTestApp('0.2.0')

      const response = await app.handle(request('/v1/test'))

      expect(response.status).toBe(426)
      const body = await response.json()
      expect(body.code).toBe('APP_VERSION_UNSUPPORTED')
    })

    it('fails closed with 426 when the header is unparseable', async () => {
      const app = createTestApp('0.2.0')

      const response = await app.handle(request('/v1/test', { 'x-app-version': 'banana' }))

      expect(response.status).toBe(426)
      const body = await response.json()
      expect(body.code).toBe('APP_VERSION_UNSUPPORTED')
    })
  })

  describe('gate disabled', () => {
    it('is a no-op when minAppVersion is empty, even with no header', async () => {
      const app = createTestApp('')

      const response = await app.handle(request('/v1/test'))

      expect(response.status).toBe(200)
    })
  })

  describe('exempt prefixes bypass the gate', () => {
    it('lets each exempt prefix through even below the minimum', async () => {
      const app = createTestApp('9.9.9')

      for (const prefix of appVersionExemptPrefixes) {
        const response = await app.handle(request(prefix, { 'x-app-version': '0.0.1' }))
        expect(response.status).toBe(200)
      }
    })

    it('lets OPTIONS through even below the minimum', async () => {
      const app = createTestApp('9.9.9')

      const response = await app.handle(
        new Request('http://localhost/v1/test', {
          method: 'OPTIONS',
          headers: { 'x-app-version': '0.0.1', origin: 'http://example.com' },
        }),
      )

      expect(response.status).toBeLessThan(400)
    })
  })

  describe('CORS on 426', () => {
    it('carries Access-Control-Allow-Origin on the short-circuited 426', async () => {
      const app = createTestApp('0.2.0')

      const response = await app.handle(request('/v1/test', { 'x-app-version': '0.1.0', origin: 'http://example.com' }))

      expect(response.status).toBe(426)
      expect(response.headers.get('access-control-allow-origin')).toBeTruthy()
    })
  })
})
