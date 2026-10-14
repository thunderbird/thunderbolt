/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createAppVersionMiddleware } from './app-version'
import { createErrorHandlingMiddleware, safeErrorHandler } from './error-handling'
import { createHttpLoggingMiddleware } from './http-logging'

const realFetch = (globalThis as Record<string, unknown>).__originalFetch as typeof fetch

/**
 * Mirror the production composition in `src/index.ts`: a `/v1`-prefixed root app,
 * the logging middleware ahead of the version gate, then route groups as separate
 * plugins, one of them behind a guard that short-circuits in `onBeforeHandle`.
 */
const createTestApp = () => {
  const lines: string[] = []
  const logger = { info: (line: string) => lines.push(line) }

  const routes = new Elysia()
    .onError(safeErrorHandler)
    .get('/ok', () => ({ ok: true }))
    .get('/health', () => ({ ok: true }))
    .get('/limited', ({ status }) => status(429, 'Too Many Requests'))
    .get('/teapot', () => new Response('short and stout', { status: 418 }))
    .get('/boom', () => {
      throw new Error('boom')
    })
    .get('/posthog/config', () => ({ ok: true }))
    .get('/posthog/e', () => ({ ok: true }))

  const guarded = new Elysia()
    .onBeforeHandle(({ request, set }) => {
      if (!request.headers.get('authorization')) {
        set.status = 401
        return { error: 'Unauthorized' }
      }
    })
    .get('/private', () => ({ ok: true }))

  const app = new Elysia({ prefix: '/v1' })
    .use(createHttpLoggingMiddleware(logger, 'cloudflare'))
    .use(createAppVersionMiddleware({ minAppVersion: '1.0.0' }))
    .use(createErrorHandlingMiddleware())
    .use(routes)
    .use(guarded)

  return { app, lines }
}

const request = (app: ReturnType<typeof createTestApp>['app'], path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { 'x-app-version': '1.0.0', ...headers } }))

describe('http-logging middleware', () => {
  it('logs a handler 200 in Common Log format with client and response time', async () => {
    const { app, lines } = createTestApp()

    const response = await request(app, '/v1/ok', { 'cf-connecting-ip': '203.0.113.7' })

    expect(response.status).toBe(200)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^203\.0\.113\.7 - "GET \/v1\/ok HTTP\/1\.1" 200 OK \d+ms$/)
  })

  it('logs a 401 returned early by a guard in another plugin', async () => {
    const { app, lines } = createTestApp()

    const response = await request(app, '/v1/private')

    expect(response.status).toBe(401)
    expect(lines).toEqual([expect.stringContaining('"GET /v1/private HTTP/1.1" 401 Unauthorized')])
  })

  it('logs a 404 for an unknown route', async () => {
    const { app, lines } = createTestApp()

    const response = await request(app, '/v1/nope')

    expect(response.status).toBe(404)
    expect(lines).toEqual([expect.stringContaining('"GET /v1/nope HTTP/1.1" 404 Not Found')])
  })

  it('logs the status of status(), a returned Response, a thrown error and the version gate', async () => {
    const { app, lines } = createTestApp()

    expect((await request(app, '/v1/limited')).status).toBe(429)
    expect((await request(app, '/v1/teapot')).status).toBe(418)
    expect((await request(app, '/v1/boom')).status).toBe(500)
    expect((await request(app, '/v1/ok', { 'x-app-version': '0.9.0' })).status).toBe(426)

    expect(lines).toEqual([
      expect.stringContaining('"GET /v1/limited HTTP/1.1" 429 Too Many Requests'),
      expect.stringContaining('"GET /v1/teapot HTTP/1.1" 418'),
      expect.stringContaining('"GET /v1/boom HTTP/1.1" 500 Internal Server Error'),
      expect.stringContaining('"GET /v1/ok HTTP/1.1" 426 Upgrade Required'),
    ])
  })

  it('skips health, static and PostHog paths but still logs PostHog config', async () => {
    const { app, lines } = createTestApp()

    expect((await request(app, '/v1/health')).status).toBe(200)
    await request(app, '/static/logo.png')
    expect((await request(app, '/v1/posthog/e')).status).toBe(200)
    expect((await request(app, '/v1/posthog/config')).status).toBe(200)

    expect(lines).toEqual([expect.stringContaining('"GET /v1/posthog/config HTTP/1.1" 200 OK')])
  })

  it('logs through a listening server, where Bun serves static paths on native routes', async () => {
    const { app, lines } = createTestApp()
    const server = app.listen(0)
    const base = `http://localhost:${server.server?.port}`

    try {
      const headers = { 'x-app-version': '1.0.0' }
      expect((await realFetch(`${base}/v1/ok`, { headers })).status).toBe(200)
      expect((await realFetch(`${base}/v1/nope`, { headers })).status).toBe(404)
    } finally {
      await server.stop(true)
    }

    expect(lines).toEqual([
      expect.stringContaining('"GET /v1/ok HTTP/1.1" 200 OK'),
      expect.stringContaining('"GET /v1/nope HTTP/1.1" 404 Not Found'),
    ])
  })
})
