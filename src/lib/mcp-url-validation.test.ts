/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isLoopbackHost, validateMcpServerUrl } from './mcp-url-validation'

describe('validateMcpServerUrl', () => {
  it('accepts https for a public host', () => {
    expect(validateMcpServerUrl('https://mcp.example.com/sse')).toEqual({ ok: true })
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

  it('rejects http for a public host that merely embeds "localhost"', () => {
    // The check pins endsWith('.localhost'), not includes — a public host must not bypass https.
    expect(validateMcpServerUrl('http://localhost.evil.com').ok).toBe(false)
  })

  it('treats only fc00::/7 (fc00–fdff) as private IPv6, not link-local/reserved', () => {
    expect(validateMcpServerUrl('http://[fe80::1]').ok).toBe(false)
    expect(validateMcpServerUrl('http://[fe00::1]').ok).toBe(false)
    expect(validateMcpServerUrl('http://[fc00::1]').ok).toBe(true)
    expect(validateMcpServerUrl('http://[fd00::1]').ok).toBe(true)
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

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST', // case-insensitive
    'api.localhost',
    'foo.bar.localhost',
    '127.0.0.1',
    '127.1.2.3', // any address in 127.0.0.0/8
    '127.255.255.255',
    '::1',
    '[::1]', // bracketed IPv6 accepted
  ])('classifies %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each([
    // Public hosts
    'example.com',
    'api.openai.com',
    // RFC1918 — intentionally NOT loopback. Browsers block http→https mixed-content
    // for these anyway, and public Custom endpoints still need the proxy for CORS.
    '10.0.0.1',
    '192.168.1.42',
    '172.16.0.1',
    // IPv6 ULA — intentionally NOT loopback (same reason)
    'fd00::1',
    'fc00::1',
    // host.docker.internal — intentionally NOT loopback. Browsers block it as
    // mixed content on HTTPS; on http docker-compose it's easier to just use
    // `localhost:PORT` (browser is on the host).
    'host.docker.internal',
    // mDNS `.local` names — intentionally NOT loopback (rare, keep on proxy).
    'mymac.local',
    // Attacker-crafted domains that look local via naive substring matching
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    '10.evil.com',
    'evil-localhost',
    // Almost-loopback IPv4 outside 127/8
    '128.0.0.1',
    '126.255.255.255',
  ])('classifies %s as NOT loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})
