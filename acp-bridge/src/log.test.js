/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'bun:test'
import {
  extractLogEvent,
  sanitizeOrigin,
  createLogger,
  isOriginAllowed,
  defaultAllowedOrigins,
} from './log.js'

describe('extractLogEvent — PII safety (the whole point)', () => {
  it('extracts method + size but NEVER the prompt text', () => {
    const secret = 'My SSN is 123-45-6789 and my API key is sk-deadbeef'
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: {
        sessionId: 'sess-abc',
        prompt: [{ type: 'text', text: secret }],
      },
    })

    const event = extractLogEvent({ direction: 'ws->agent', line: frame })
    const serialized = JSON.stringify(event)

    // The safe scalars ARE present.
    expect(event.method).toBe('session/prompt')
    expect(event.kind).toBe('request')
    expect(event.id).toBe(7)
    expect(event.byteSize).toBe(Buffer.byteLength(frame))

    // None of the content leaks — not the prompt text, not the SSN, not the
    // key, not the sessionId, not the params shape. (The method name
    // "session/prompt" IS expected: it's an allowlisted structural enum value,
    // not user content.)
    expect(serialized).not.toContain('SSN')
    expect(serialized).not.toContain('123-45-6789')
    expect(serialized).not.toContain('sk-deadbeef')
    expect(serialized).not.toContain('sess-abc')
    expect(serialized).not.toContain('params')
    expect(serialized).not.toContain('text')
  })

  it('collapses unknown/attacker-controlled methods to "other"', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'leak/secret-token-aaa-bbb-ccc',
    })
    const event = extractLogEvent({ direction: 'agent->ws', line: frame })
    expect(event.method).toBe('other')
    expect(JSON.stringify(event)).not.toContain('secret-token')
  })

  it('does not leak tool output from a session/update notification', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { kind: 'agent_message_chunk', content: { text: 'internal file /etc/passwd contents' } } },
    })
    const event = extractLogEvent({ direction: 'agent->ws', line: frame })
    expect(event.kind).toBe('notification')
    expect(event.method).toBe('session/update')
    expect(JSON.stringify(event)).not.toContain('/etc/passwd')
  })

  it('classifies a response (id, result, no method) as kind=response status=ok', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { secret: 'value' } })
    const event = extractLogEvent({ direction: 'agent->ws', line: frame })
    expect(event.kind).toBe('response')
    expect(event.status).toBe('ok')
    expect(event.id).toBe(9)
    expect(JSON.stringify(event)).not.toContain('secret')
  })

  it('extracts an integer error.code but not error.message/data', () => {
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601, message: 'Method not found: leak', data: { path: '/home/u/.ssh/id_rsa' } },
    })
    const event = extractLogEvent({ direction: 'agent->ws', line: frame })
    expect(event.kind).toBe('error')
    expect(event.status).toBe('error')
    expect(event.errorCode).toBe(-32601)
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('id_rsa')
    expect(serialized).not.toContain('Method not found')
  })

  it('flags a non-JSON line without echoing its content', () => {
    const event = extractLogEvent({ direction: 'agent->ws', line: 'WARN booting with token=abc123' })
    expect(event.kind).toBe('non-json')
    expect(event.parseError).toBe(true)
    expect(event.byteSize).toBeGreaterThan(0)
    expect(JSON.stringify(event)).not.toContain('abc123')
  })

  it('drops a non-scalar id rather than serializing it', () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: { nested: 'secret' }, method: 'initialize' })
    const event = extractLogEvent({ direction: 'agent->ws', line: frame })
    expect(event.id).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('secret')
  })

  it('passes a numeric id through untouched (numbers are bounded)', () => {
    const event = extractLogEvent({ direction: 'agent->ws', line: JSON.stringify({ id: 123456789, method: 'initialize' }) })
    expect(event.id).toBe(123456789)
  })

  it('keeps a short string id verbatim', () => {
    const event = extractLogEvent({ direction: 'agent->ws', line: JSON.stringify({ id: 'req-42', method: 'initialize' }) })
    expect(event.id).toBe('req-42')
  })

  it('truncates a long content-bearing string id so the content cannot leak', () => {
    // The first 8 chars are a harmless prefix; the secrets live past the cutoff.
    const content = 'req-0001-SSN-123-45-6789-and-api-key-sk-deadbeef-hidden'
    const frame = JSON.stringify({ jsonrpc: '2.0', id: content, method: 'initialize' })
    const event = extractLogEvent({ direction: 'agent->ws', line: frame })

    expect(typeof event.id).toBe('string')
    expect(event.id.length).toBeLessThanOrEqual(9) // 8 chars + '…'
    expect(event.id).toBe('req-0001…')
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('SSN')
    expect(serialized).not.toContain('123-45-6789')
    expect(serialized).not.toContain('sk-deadbeef')
  })

  it('handles valid JSON that is not an rpc object', () => {
    const event = extractLogEvent({ direction: 'agent->ws', line: '[1,2,3]' })
    expect(event.kind).toBe('non-rpc')
  })
})

describe('sanitizeOrigin', () => {
  it('keeps only scheme + host of a browser origin', () => {
    expect(sanitizeOrigin('https://app.thunderbolt.io')).toBe('https://app.thunderbolt.io')
  })

  it('strips any path/query', () => {
    expect(sanitizeOrigin('https://evil.test/leak?token=abc')).toBe('https://evil.test')
  })

  it('returns "none" for missing origin', () => {
    expect(sanitizeOrigin(undefined)).toBe('none')
    expect(sanitizeOrigin('')).toBe('none')
  })

  it('returns "invalid" for an unparseable origin', () => {
    expect(sanitizeOrigin('not a url')).toBe('invalid')
  })
})

describe('isOriginAllowed', () => {
  it('allowlists the Thunderbolt app origins by default', () => {
    expect(defaultAllowedOrigins).toContain('https://app.thunderbolt.io')
    expect(defaultAllowedOrigins).toContain('tauri://localhost')
    expect(defaultAllowedOrigins).toContain('http://tauri.localhost')
    expect(defaultAllowedOrigins).toContain('http://localhost:1420')
    for (const origin of defaultAllowedOrigins) {
      expect(isOriginAllowed(origin, defaultAllowedOrigins)).toBe(true)
    }
  })

  it('accepts every loopback spelling of the Vite dev origin (same local origin)', () => {
    // The dev server binds loopback and is reachable as localhost, 127.0.0.1,
    // and [::1] — all the same origin, so all three must be allowed.
    expect(isOriginAllowed('http://localhost:1420', defaultAllowedOrigins)).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:1420', defaultAllowedOrigins)).toBe(true)
    expect(isOriginAllowed('http://[::1]:1420', defaultAllowedOrigins)).toBe(true)
    // It's the dev origin specifically, not blanket-loopback: a different port
    // on the same loopback host is still rejected.
    expect(isOriginAllowed('http://127.0.0.1:9999', defaultAllowedOrigins)).toBe(false)
  })

  it('allows a missing/empty origin (native + Tauri webviews send none)', () => {
    expect(isOriginAllowed(undefined, defaultAllowedOrigins)).toBe(true)
    expect(isOriginAllowed('', defaultAllowedOrigins)).toBe(true)
  })

  it('rejects an unknown origin', () => {
    expect(isOriginAllowed('https://evil.example', defaultAllowedOrigins)).toBe(false)
  })

  it('ignores a trailing slash / path when matching (normalized)', () => {
    expect(isOriginAllowed('https://app.thunderbolt.io/', defaultAllowedOrigins)).toBe(true)
  })

  it('rejects an unparseable origin', () => {
    expect(isOriginAllowed('not a url', defaultAllowedOrigins)).toBe(false)
  })

  it('honors an extended allowlist', () => {
    const extended = [...defaultAllowedOrigins, 'http://localhost:9999']
    expect(isOriginAllowed('http://localhost:9999', extended)).toBe(true)
    expect(isOriginAllowed('http://localhost:9999', defaultAllowedOrigins)).toBe(false)
  })
})

describe('createLogger', () => {
  const capture = () => {
    const out = []
    return { stream: { write: (s) => out.push(s) }, out }
  }

  it('json mode emits one JSON object per line with level', () => {
    const { stream, out } = capture()
    const log = createLogger({ json: true, stream })
    log.info({ lifecycle: 'listening', port: 8080 })
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0])
    expect(parsed).toEqual({ level: 'info', lifecycle: 'listening', port: 8080 })
  })

  it('pretty mode emits a compact one-liner with no content column', () => {
    const { stream, out } = capture()
    const log = createLogger({ json: false, stream })
    log.info({ lifecycle: 'listening', port: 8080 })
    expect(out[0]).toBe('INFO  lifecycle=listening port=8080\n')
  })

  it('suppresses debug events unless verbose', () => {
    const quiet = capture()
    createLogger({ stream: quiet.stream }).debug({ kind: 'request' })
    expect(quiet.out).toHaveLength(0)

    const loud = capture()
    createLogger({ verbose: true, stream: loud.stream }).debug({ kind: 'request' })
    expect(loud.out).toHaveLength(1)
  })

  it('omits undefined fields from pretty output', () => {
    const { stream, out } = capture()
    createLogger({ stream }).info({ lifecycle: 'connected', origin: undefined })
    expect(out[0]).toBe('INFO  lifecycle=connected\n')
  })
})
