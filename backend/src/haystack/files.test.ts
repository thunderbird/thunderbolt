/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Route-level tests for `GET /v1/haystack/files/:fileId`. The route is a
 * thin authenticated proxy onto Deepset's file-download endpoint, so we
 * exercise:
 *  - the auth gate (401 unauth, 403 anonymous),
 *  - the upstream URL + Bearer header propagation,
 *  - happy-path streaming with passthrough of `content-type`, `content-length`,
 *    and `content-disposition`,
 *  - error-status passthrough (404 stays 404) and the 401→502 remap so a
 *    misconfigured server-side key doesn't surface as "user needs to re-login".
 *
 * Following backend/docs/testing.md: dependencies (Auth, fetchFn) are
 * injected — no `mock.module()`.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { resetAgentProvidersForTesting } from '@/agents/discovery'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createHaystackRoutes } from './routes'

/** Build an `Auth` whose `getSession` returns the provided user shape. */
const buildAuth = (user: { id: string; isAnonymous: boolean } | null): Auth => {
  return {
    api: {
      getSession: () => Promise.resolve(user ? { user, session: {} } : null),
    },
  } as unknown as Auth
}

type FetchCapture = { url: string; method?: string; headers: Record<string, string> }

const captureFetch = (
  captures: FetchCapture[],
  responder: (url: string) => Response | Promise<Response>,
): typeof fetch => {
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input.toString()
    const rawHeaders = init?.headers
    const headers: Record<string, string> = {}
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) {
          headers[k] = v
        }
      } else {
        Object.assign(headers, rawHeaders)
      }
    }
    captures.push({ url, method: init?.method, headers })
    return responder(url)
  }
  return Object.assign(impl, { preconnect: () => {} }) as unknown as typeof fetch
}

const haystackSettings = createTestSettings({
  haystackBaseUrl: 'https://haystack.test',
  haystackApiKey: 'sekrit',
  haystackWorkspace: 'ws-test',
  haystackPipelines: '',
})

const buildApp = (auth: Auth, fetchFn: typeof fetch) =>
  new Elysia({ prefix: '/v1' }).use(createHaystackRoutes(haystackSettings, auth, { fetchFn }))

describe('GET /v1/haystack/files/:fileId', () => {
  beforeEach(() => {
    resetAgentProvidersForTesting()
  })

  afterEach(() => {
    resetAgentProvidersForTesting()
  })

  it('returns 401 when no session is present', async () => {
    const fetchFn = captureFetch([], () => new Response('', { status: 500 }))
    const app = buildApp(buildAuth(null), fetchFn)
    const res = await app.handle(new Request('http://localhost/v1/haystack/files/file-1'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 ANONYMOUS_FILE_FORBIDDEN for anonymous users', async () => {
    const fetchFn = captureFetch([], () => new Response('', { status: 500 }))
    const app = buildApp(buildAuth({ id: 'anon-1', isAnonymous: true }), fetchFn)
    const res = await app.handle(new Request('http://localhost/v1/haystack/files/file-1'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ error: 'Forbidden', code: 'ANONYMOUS_FILE_FORBIDDEN' })
  })

  it('streams the upstream body and passes through content-type / disposition / length', async () => {
    const captures: FetchCapture[] = []
    const fileBody = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    const fetchFn = captureFetch(
      captures,
      () =>
        new Response(fileBody, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(fileBody.byteLength),
            'content-disposition': 'attachment; filename="doc.pdf"',
          },
        }),
    )
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }), fetchFn)
    const res = await app.handle(new Request('http://localhost/v1/haystack/files/file-abc_123'))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-length')).toBe(String(fileBody.byteLength))
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="doc.pdf"')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')

    const buf = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(buf)).toEqual(Array.from(fileBody))

    // Upstream URL + Bearer auth header are correct.
    expect(captures).toHaveLength(1)
    expect(captures[0].url).toBe('https://haystack.test/api/v1/workspaces/ws-test/files/file-abc_123')
    expect(captures[0].method).toBe('GET')
    expect(captures[0].headers.authorization).toBe('Bearer sekrit')
  })

  it('rejects file ids with disallowed characters via the param validator', async () => {
    const captures: FetchCapture[] = []
    const fetchFn = captureFetch(captures, () => new Response('', { status: 500 }))
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }), fetchFn)
    // Slashes can't escape — Elysia treats them as path separators — but a
    // dotfile-style id with `..` should be rejected by the [\w-]+ pattern.
    const res = await app.handle(new Request('http://localhost/v1/haystack/files/..%2Fetc'))
    // Either 422 (validator) or 404 (router) — both block the upstream call.
    expect([400, 404, 422]).toContain(res.status)
    expect(captures).toHaveLength(0)
  })

  it('passes through upstream 404 as 404', async () => {
    const fetchFn = captureFetch([], () => new Response('not found', { status: 404, statusText: 'Not Found' }))
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }), fetchFn)
    const res = await app.handle(new Request('http://localhost/v1/haystack/files/missing-1'))
    expect(res.status).toBe(404)
  })

  it('remaps upstream 401 to 502 with a clear message', async () => {
    const fetchFn = captureFetch([], () => new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }))
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }), fetchFn)
    const res = await app.handle(new Request('http://localhost/v1/haystack/files/file-1'))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({ error: 'upstream auth failed' })
  })

  it('does not bleed state between concurrent requests', async () => {
    const captures: FetchCapture[] = []
    const fetchFn = captureFetch(captures, (url) => {
      // Different payload per file id so a mix-up would be visible.
      const id = url.split('/').pop()!
      const payload = new TextEncoder().encode(`body-for-${id}`)
      return new Response(payload, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.byteLength) },
      })
    })
    const app = buildApp(buildAuth({ id: 'user-1', isAnonymous: false }), fetchFn)

    const [resA, resB] = await Promise.all([
      app.handle(new Request('http://localhost/v1/haystack/files/file-a')),
      app.handle(new Request('http://localhost/v1/haystack/files/file-b')),
    ])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(new TextDecoder().decode(await resA.arrayBuffer())).toBe('body-for-file-a')
    expect(new TextDecoder().decode(await resB.arrayBuffer())).toBe('body-for-file-b')
    expect(captures.map((c) => c.url).sort()).toEqual([
      'https://haystack.test/api/v1/workspaces/ws-test/files/file-a',
      'https://haystack.test/api/v1/workspaces/ws-test/files/file-b',
    ])
  })
})
