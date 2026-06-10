/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { validateMcpServerUrl } from './mcp-url-validation'

describe('validateMcpServerUrl', () => {
  it('accepts https for a public host', () => {
    expect(validateMcpServerUrl('https://mcp.example.com/sse')).toEqual({ ok: true })
  })

  it('accepts https for any host (loopback, private, public)', () => {
    expect(validateMcpServerUrl('https://localhost:3000')).toEqual({ ok: true })
    expect(validateMcpServerUrl('https://192.168.1.10')).toEqual({ ok: true })
    expect(validateMcpServerUrl('https://example.com')).toEqual({ ok: true })
  })

  it('rejects http for a public host with an https-mentioning reason', () => {
    const result = validateMcpServerUrl('http://mcp.example.com')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('https')
    }
  })

  it('accepts http for localhost (with and without port) and *.localhost', () => {
    expect(validateMcpServerUrl('http://localhost')).toEqual({ ok: true })
    expect(validateMcpServerUrl('http://localhost:8080/mcp')).toEqual({ ok: true })
    expect(validateMcpServerUrl('http://api.localhost:8080')).toEqual({ ok: true })
  })

  it('accepts http for loopback IPv4 (127.0.0.1)', () => {
    expect(validateMcpServerUrl('http://127.0.0.1:9000')).toEqual({ ok: true })
  })

  it('accepts http for loopback IPv6 ([::1])', () => {
    expect(validateMcpServerUrl('http://[::1]:9000')).toEqual({ ok: true })
  })

  it('accepts http for RFC-1918 private ranges', () => {
    expect(validateMcpServerUrl('http://192.168.1.10')).toEqual({ ok: true })
    expect(validateMcpServerUrl('http://10.0.0.5')).toEqual({ ok: true })
    expect(validateMcpServerUrl('http://172.16.0.1')).toEqual({ ok: true })
    expect(validateMcpServerUrl('http://172.31.255.254')).toEqual({ ok: true })
  })

  it('accepts http for an IPv6 unique-local address (fc00::/7)', () => {
    expect(validateMcpServerUrl('http://[fd00::1]:9000')).toEqual({ ok: true })
  })

  it('rejects http for a public IPv4 that resembles a private range', () => {
    expect(validateMcpServerUrl('http://172.32.0.1').ok).toBe(false)
    expect(validateMcpServerUrl('http://11.0.0.1').ok).toBe(false)
  })

  it('rejects non-http(s) schemes (ws://, file://)', () => {
    expect(validateMcpServerUrl('ws://localhost:9000').ok).toBe(false)
    expect(validateMcpServerUrl('file:///etc/hosts').ok).toBe(false)
  })

  it('rejects an unparseable garbage string', () => {
    expect(validateMcpServerUrl('not a url').ok).toBe(false)
    expect(validateMcpServerUrl('').ok).toBe(false)
  })
})
