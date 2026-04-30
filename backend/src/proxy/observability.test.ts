/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { redactPaths } from '@/config/logger'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { pino, type Logger } from 'pino'
import { Writable } from 'node:stream'
import { createUniversalProxyRoutes } from './routes'
import { createProxyObserver, type ProxyObservationInput, type ProxyObserver } from './observability'

// Mock DNS + net — external Node APIs, acceptable per docs/testing.md "When You Must Mock"
const mockDnsLookup = mock(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))
mock.module('node:net', () => ({ isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0) }))

const fakeAuth = {
  api: {
    getSession: async () => ({
      user: { id: 'user-42', email: 'test@example.com' },
      session: { id: 'sess-42' },
    }),
  },
} as never

const okResponse = (body = 'ok') => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })

/**
 * Pino logger that captures every emitted record into an in-memory array, so
 * tests can assert on the redacted payload without touching the real stdout
 * stream. Uses a Node Writable adapter (no extra deps needed).
 */
const captureLogger = (): { logger: Logger; records: Record<string, unknown>[] } => {
  const records: Record<string, unknown>[] = []
  const writable = new Writable({
    write(chunk, _enc, cb) {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          records.push(JSON.parse(line))
        } catch {
          // Pretty-printer output during tests — ignore (we set NODE_ENV=production-like below).
        }
      }
      cb()
    },
  })
  const logger = pino(
    {
      level: 'debug',
      redact: { paths: redactPaths, censor: '[REDACTED]', remove: false },
    },
    writable,
  )
  return { logger, records }
}

describe('proxy observability', () => {
  let consoleSpies: ConsoleSpies

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  // ---------------------------------------------------------------------------
  // Logger redact rules
  // ---------------------------------------------------------------------------

  describe('logger redact', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['req.headers.authorization', { req: { headers: { authorization: 'Bearer secret-token' } } }],
      ['req.headers.cookie', { req: { headers: { cookie: 'session=abc; csrf=xyz' } } }],
      [
        'req.headers["x-upstream-authorization"]',
        { req: { headers: { 'x-upstream-authorization': 'Bearer upstream-token' } } },
      ],
      ['req.headers["mcp-session-id"]', { req: { headers: { 'mcp-session-id': 'session-id-value' } } }],
      ['res.headers["set-cookie"]', { res: { headers: { 'set-cookie': 'session=abc; HttpOnly' } } }],
      ['req.url', { req: { url: 'https://example.com/secret?token=hunter2' } }],
      ['email', { email: 'leaked@example.com' }],
    ]

    for (const [path, payload] of cases) {
      it(`redacts ${path}`, () => {
        const { logger, records } = captureLogger()
        logger.info(payload, 'test')
        expect(records).toHaveLength(1)
        // Walk the payload to find the original value and confirm it does NOT
        // appear anywhere in the serialized record.
        const serialized = JSON.stringify(records[0])
        // Pull out the leaf string from payload (works for our flat test payloads).
        const findLeaf = (obj: unknown): string | null => {
          if (typeof obj === 'string') return obj
          if (obj && typeof obj === 'object') {
            for (const v of Object.values(obj as Record<string, unknown>)) {
              const found = findLeaf(v)
              if (found) return found
            }
          }
          return null
        }
        const leaked = findLeaf(payload)
        expect(leaked).toBeTruthy()
        expect(serialized).not.toContain(leaked!)
        expect(serialized).toContain('[REDACTED]')
      })
    }
  })

  // ---------------------------------------------------------------------------
  // Happy-path HTTP request emits one structured log entry with the right shape
  // ---------------------------------------------------------------------------

  describe('emits one observation per HTTP request', () => {
    let mockFetch: ReturnType<typeof mock>
    let observations: ProxyObservationInput[]
    let observer: ProxyObserver

    beforeEach(() => {
      mockFetch = mock(() => Promise.resolve(okResponse()))
      observations = []
      observer = (input) => observations.push(input)
      mockDnsLookup.mockReset()
      mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
    })

    it('emits exactly one entry with the documented shape', async () => {
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://example.com/resource'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
          method: 'GET',
          headers: { 'X-Request-ID': 'req-abc-123' },
        }),
      )
      // Drain the stream so capStream's onComplete fires.
      await res.text()

      expect(observations).toHaveLength(1)
      const o = observations[0]
      expect(o.method).toBe('GET')
      expect(o.targetHost).toBe('example.com')
      expect(o.status).toBe(200)
      expect(typeof o.durationMs).toBe('number')
      expect(o.durationMs).toBeGreaterThanOrEqual(0)
      expect(o.userId).toBe('user-42')
      expect(o.requestId).toBe('req-abc-123')
      expect(typeof o.bytesIn).toBe('number')
      expect(typeof o.bytesOut).toBe('number')
      expect(o.errorType).toBeUndefined()
    })

    it('uses targetHost (hostname only) — never the full URL', async () => {
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://api.example.com:8443/path/with/secrets?token=hunter2'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
      )
      await res.text()

      expect(observations).toHaveLength(1)
      expect(observations[0].targetHost).toBe('api.example.com')
      // Ensure no observation field contains the path or query string.
      const serialized = JSON.stringify(observations[0])
      expect(serialized).not.toContain('hunter2')
      expect(serialized).not.toContain('/path/with/secrets')
    })

    it('generates a request_id when X-Request-ID header is absent', async () => {
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://example.com/resource'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
      )
      await res.text()
      expect(observations[0].requestId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('captures bytes_in from POST body and bytes_out from response body', async () => {
      const responseBody = 'response-body-content'
      mockFetch.mockImplementation(() => Promise.resolve(new Response(responseBody, { status: 200 })))
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://example.com/api'
      const requestBody = JSON.stringify({ payload: 'x'.repeat(50) })
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
          method: 'POST',
          body: requestBody,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await res.text()

      expect(observations).toHaveLength(1)
      expect(observations[0].bytesIn).toBe(requestBody.length)
      expect(observations[0].bytesOut).toBe(responseBody.length)
    })
  })

  // ---------------------------------------------------------------------------
  // PostHog event — restricted property set, never user_id / body / full URL
  // ---------------------------------------------------------------------------

  describe('PostHog $proxy_request event', () => {
    let mockFetch: ReturnType<typeof mock>
    let captures: Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }>
    let posthog: { capture: (e: { distinctId: string; event: string; properties?: Record<string, unknown> }) => void }

    beforeEach(() => {
      mockFetch = mock(() => Promise.resolve(okResponse('hello')))
      captures = []
      posthog = { capture: (e) => captures.push(e) }
      mockDnsLookup.mockReset()
      mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
    })

    it('emits $proxy_request with only allowed properties', async () => {
      const { logger } = captureLogger()
      const observer = createProxyObserver({ logger, posthog: posthog as never })
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://api.example.com/v1/resource?token=secret'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
          method: 'GET',
          headers: { Authorization: 'Bearer client-token' },
        }),
      )
      await res.text()

      expect(captures).toHaveLength(1)
      const event = captures[0]
      expect(event.event).toBe('$proxy_request')
      // distinctId MUST be the anonymous sentinel — no user_id leakage.
      expect(event.distinctId).toBe('server')

      const props = event.properties ?? {}
      expect(props.target_host).toBe('api.example.com')
      expect(props.method).toBe('GET')
      expect(props.status).toBe(200)
      expect(typeof props.duration_ms).toBe('number')
      expect(props.proxy_kind).toBe('http')

      // Forbidden fields — none of these may appear in PostHog properties.
      const allowedKeys = new Set(['target_host', 'method', 'status', 'duration_ms', 'proxy_kind', 'error_type'])
      for (const key of Object.keys(props)) {
        expect(allowedKeys.has(key)).toBe(true)
      }
      // No user-identifying or content fields anywhere in the serialized event.
      const serialized = JSON.stringify(event)
      expect(serialized).not.toContain('user-42')
      expect(serialized).not.toContain('test@example.com')
      expect(serialized).not.toContain('client-token')
      expect(serialized).not.toContain('hello') // response body
      expect(serialized).not.toContain('/v1/resource')
      expect(serialized).not.toContain('token=secret')
    })

    it('skips PostHog when posthog client is null', async () => {
      const { logger, records } = captureLogger()
      const observer = createProxyObserver({ logger, posthog: null })
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://example.com/resource'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
      )
      await res.text()
      // Logger still fires, no exceptions thrown.
      expect(records.find((r) => r.event === 'proxy_request')).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // Structured log emission via real pino + redact
  // ---------------------------------------------------------------------------

  describe('structured log emission', () => {
    it('emits one proxy_request log line with the documented field set', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse('payload')))
      mockDnsLookup.mockReset()
      mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))

      const { logger, records } = captureLogger()
      const observer = createProxyObserver({ logger, posthog: null })

      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://api.example.com/v1/data?bearer=secret'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
          method: 'GET',
          headers: { 'X-Request-ID': 'req-xyz', Authorization: 'Bearer leaked' },
        }),
      )
      await res.text()

      const proxyLogs = records.filter((r) => r.event === 'proxy_request')
      expect(proxyLogs).toHaveLength(1)
      const log = proxyLogs[0]
      expect(log.method).toBe('GET')
      expect(log.target_host).toBe('api.example.com')
      expect(log.status).toBe(200)
      expect(typeof log.duration_ms).toBe('number')
      expect(log.user_id).toBe('user-42')
      expect(log.request_id).toBe('req-xyz')
      expect(typeof log.bytes_in).toBe('number')
      expect(typeof log.bytes_out).toBe('number')

      // Forbidden values must not appear anywhere in the serialized record.
      const serialized = JSON.stringify(log)
      expect(serialized).not.toContain('Bearer leaked')
      expect(serialized).not.toContain('bearer=secret')
      expect(serialized).not.toContain('/v1/data')
    })
  })

  // ---------------------------------------------------------------------------
  // OTel trace context propagation
  // ---------------------------------------------------------------------------

  describe('OTel trace context', () => {
    // OTel instrumentation is opt-in via OTEL_EXPORTER_OTLP_ENDPOINT and is NOT
    // enabled in tests. This test asserts the integration is non-throwing in
    // the absence of an active span (the common test path) — the production
    // path simply attaches additional attributes when a span exists.
    it('does not throw and omits trace_id when no span is active', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse('ok')))
      mockDnsLookup.mockReset()
      mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))

      const { logger, records } = captureLogger()
      const observer = createProxyObserver({ logger, posthog: null })

      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent('https://example.com/x')}`, { method: 'GET' }),
      )
      await res.text()

      const log = records.find((r) => r.event === 'proxy_request')
      expect(log).toBeTruthy()
      expect(log!.trace_id).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Error path: error_type is a classified label, not raw text
  // ---------------------------------------------------------------------------

  describe('error classification', () => {
    let observations: ProxyObservationInput[]
    let observer: ProxyObserver

    beforeEach(() => {
      observations = []
      observer = (input) => observations.push(input)
      mockDnsLookup.mockReset()
      mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
    })

    it('classifies invalid URL as invalid_url', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse()))
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      // %ZZ is invalid percent-encoding → decodeURIComponent throws
      const res = await app.handle(new Request('http://localhost/proxy/%ZZ', { method: 'GET' }))
      expect(res.status).toBe(400)
      expect(observations).toHaveLength(1)
      expect(observations[0].errorType).toBe('invalid_url')
    })

    it('classifies non-HTTPS target as unsupported_protocol', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse()))
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'http://example.com/resource'
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
      )
      expect(res.status).toBe(400)
      expect(observations[0].errorType).toBe('unsupported_protocol')
    })

    it('classifies invalid X-Upstream-Authorization as invalid_header', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse()))
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://example.com/resource'
      // Construct headers manually to bypass fetch's header constructor validation
      // (it rejects CRLF) — we want to assert routes.ts's own isPrintableAscii guard.
      const headers = new Headers()
      headers.set('X-Upstream-Authorization', 'Bearerÿ')
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
          method: 'GET',
          headers,
        }),
      )
      expect(res.status).toBe(400)
      expect(observations[0].errorType).toBe('invalid_header')
    })

    it('classifies oversized body as body_too_large', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse()))
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'https://example.com/upload'
      const bigBody = new Uint8Array(11 * 1024 * 1024)
      const res = await app.handle(
        new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
          method: 'POST',
          body: bigBody,
          headers: { 'content-length': String(bigBody.byteLength) },
        }),
      )
      expect(res.status).toBe(413)
      expect(observations[0].errorType).toBe('body_too_large')
    })

    it('error_type is a known label — never raw error text', async () => {
      const mockFetch = mock(() => Promise.resolve(okResponse()))
      const app = new Elysia().use(
        createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, undefined, observer),
      )
      const target = 'http://example.com/resource' // forces unsupported_protocol
      await app.handle(new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }))

      const allowedLabels = new Set([
        'invalid_url',
        'unsupported_protocol',
        'invalid_header',
        'method_not_allowed',
        'body_too_large',
        'ssrf_block',
        'dns_timeout',
        'too_many_redirects',
        'redirect_protocol',
        'rate_limit',
        'auth',
        'upstream_error',
        'cap_exceeded',
        'idle_timeout',
        'client_disconnect',
      ])
      expect(allowedLabels.has(observations[0].errorType!)).toBe(true)
    })
  })
})
