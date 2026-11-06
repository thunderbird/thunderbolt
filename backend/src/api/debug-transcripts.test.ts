/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMockAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createDebugTranscriptsRoutes } from './debug-transcripts'

const validBody = {
  threadId: 'thread-123',
  schemaVersion: 1,
  payload: { turns: [] },
  userNote: 'note',
  clientVersion: '0.1.123',
}

const relaySettings = createTestSettings({
  debugTranscriptsEnabled: true,
  debugTranscriptUpstreamUrl: 'https://intake.example.test',
  debugTranscriptUpstreamKey: 'relay-key',
})

/** Records the forwarded request and answers with the given response. */
const fakeIntake = (response: () => Response | Promise<Response>) => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return response()
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

const post = (
  app: ReturnType<typeof createDebugTranscriptsRoutes>,
  body: BodyInit,
  headers: Record<string, string> = {},
) =>
  app.handle(
    new Request('http://localhost/debug-transcripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    }),
  )

describe('Debug transcript relay', () => {
  it('returns a coded 403 when the relay is not configured', async () => {
    const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: createTestSettings(), fetchFn: fetch })
    const response = await post(app, '{invalid')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Debug transcript uploads are disabled',
      code: 'DEBUG_TRANSCRIPTS_DISABLED',
    })
  })

  it('returns 401 when unauthenticated', async () => {
    const app = createDebugTranscriptsRoutes({ auth: mockAuthUnauthenticated, settings: relaySettings, fetchFn: fetch })
    expect((await post(app, JSON.stringify(validBody))).status).toBe(401)
  })

  it('forwards the submission with the bearer key and returns the intake id', async () => {
    const intake = fakeIntake(() => Response.json({ id: 'intake-id' }, { status: 201 }))
    const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: relaySettings, fetchFn: intake.fetchFn })

    const response = await post(app, JSON.stringify(validBody))

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 'intake-id' })
    expect(intake.calls).toHaveLength(1)
    expect(intake.calls[0].url).toBe('https://intake.example.test/v1/debug-transcripts/intake')
    expect(new Headers(intake.calls[0].init.headers).get('authorization')).toBe('Bearer relay-key')
    expect(JSON.parse(String(intake.calls[0].init.body))).toEqual({ ...validBody, userId: 'test-user' })
  })

  it('forwards anonymous sessions with a null userId', async () => {
    const intake = fakeIntake(() => Response.json({ id: 'x' }, { status: 201 }))
    const app = createDebugTranscriptsRoutes({
      auth: createMockAuth('anon-1', true),
      settings: relaySettings,
      fetchFn: intake.fetchFn,
    })

    expect((await post(app, JSON.stringify(validBody))).status).toBe(201)
    expect(JSON.parse(String(intake.calls[0].init.body)).userId).toBeNull()
  })

  it('answers 502 when the intake rejects, times out, or is unreachable, without retrying', async () => {
    for (const response of [
      () => Response.json({ error: 'nope' }, { status: 401 }),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new DOMException('Timed out', 'TimeoutError')),
    ]) {
      const intake = fakeIntake(response)
      const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: relaySettings, fetchFn: intake.fetchFn })
      const result = await post(app, JSON.stringify(validBody))
      expect(result.status).toBe(502)
      expect(await result.json()).toEqual({
        error: 'Debug transcript upstream rejected the upload',
        code: 'DEBUG_TRANSCRIPT_UPSTREAM_FAILED',
      })
      expect(intake.calls).toHaveLength(1)
    }
  })

  it('rejects unexpected top-level fields with 422 before forwarding', async () => {
    const intake = fakeIntake(() => Response.json({ id: 'x' }, { status: 201 }))
    const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: relaySettings, fetchFn: intake.fetchFn })
    expect((await post(app, JSON.stringify({ ...validBody, userId: 'spoofed' }))).status).toBe(422)
    expect(intake.calls).toHaveLength(0)
  })

  it('rejects an oversized chunked body without content-length with 413', async () => {
    const intake = fakeIntake(() => Response.json({ id: 'x' }, { status: 201 }))
    const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: relaySettings, fetchFn: intake.fetchFn })
    const big = JSON.stringify({ ...validBody, payload: { blob: 'x'.repeat(2 * 1024 * 1024 + 8 * 1024) } })
    const stream = new Blob([big]).stream()
    const response = await app.handle(
      new Request('http://localhost/debug-transcripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    expect(intake.calls).toHaveLength(0)
  })

  it('does not gate unrelated routes', async () => {
    const host = new Elysia()
      .get('/health', () => ({ ok: true }))
      .use(createDebugTranscriptsRoutes({ auth: mockAuth, settings: createTestSettings(), fetchFn: fetch }))
    expect((await host.handle(new Request('http://localhost/health'))).status).toBe(200)
  })
  it('enforces the separate 2 MB payload boundary within the whole-request cap', async () => {
    const intake = fakeIntake(() => Response.json({ id: 'x' }, { status: 201 }))
    const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: relaySettings, fetchFn: intake.fetchFn })
    const atLimit = { blob: 'x'.repeat(2 * 1024 * 1024 - JSON.stringify({ blob: '' }).length) }
    expect((await post(app, JSON.stringify({ ...validBody, payload: atLimit }))).status).toBe(201)
    const result = await post(app, JSON.stringify({ ...validBody, payload: { blob: atLimit.blob + 'x' } }))
    expect(result.status).toBe(413)
    expect((await result.json()).code).toBe('DEBUG_TRANSCRIPT_TOO_LARGE')
    expect(intake.calls).toHaveLength(1)
  })
  it.each([
    ['missing id', () => Response.json({ error: 'not accepted' }, { status: 201 })],
    ['empty id', () => Response.json({ id: '' }, { status: 201 })],
    ['non-string id', () => Response.json({ id: 123 }, { status: 201 })],
    ['malformed JSON', () => new Response('{invalid', { status: 201 })],
    [
      'body stream error',
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(new Error('Body read failed')),
          }),
          { status: 201 },
        ),
    ],
  ] as const)('returns 502 for an intake 201 with %s', async (_name, response) => {
    const intake = fakeIntake(response)
    const app = createDebugTranscriptsRoutes({ auth: mockAuth, settings: relaySettings, fetchFn: intake.fetchFn })
    const result = await post(app, JSON.stringify(validBody))
    expect(result.status).toBe(502)
    expect(await result.json()).toEqual({
      error: 'Debug transcript upstream rejected the upload',
      code: 'DEBUG_TRANSCRIPT_UPSTREAM_FAILED',
    })
    expect(intake.calls).toHaveLength(1)
  })
})
