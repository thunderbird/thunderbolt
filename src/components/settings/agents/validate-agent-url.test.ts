/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { inferTransport, validateAgentUrl } from './validate-agent-url'

describe('inferTransport', () => {
  it('returns websocket for wss:// URLs', () => {
    expect(inferTransport('wss://example.com/ws')).toBe('websocket')
  })

  it('returns websocket for ws:// URLs', () => {
    expect(inferTransport('ws://example.com/ws')).toBe('websocket')
  })

  it('returns null for http:// URLs (unsupported)', () => {
    expect(inferTransport('http://example.com/acp')).toBeNull()
  })

  it('returns null for https:// URLs (unsupported)', () => {
    expect(inferTransport('https://example.com/acp')).toBeNull()
  })

  it('returns null for unsupported schemes', () => {
    expect(inferTransport('ftp://example.com/acp')).toBeNull()
  })

  it('returns null for malformed URLs', () => {
    expect(inferTransport('not a url')).toBeNull()
    expect(inferTransport('')).toBeNull()
  })

  it('returns iroh for a bare 52-char base32 NodeId', () => {
    expect(inferTransport('a'.repeat(52))).toBe('iroh')
  })

  it('returns iroh for a longer node-prefixed EndpointTicket', () => {
    expect(inferTransport('node' + 'b'.repeat(120))).toBe('iroh')
  })

  it('returns null for a base32 token shorter than a NodeId', () => {
    expect(inferTransport('abcdef234567')).toBeNull()
  })

  it('returns null for an uppercased NodeId (iroh emits lowercase base32)', () => {
    expect(inferTransport('A'.repeat(52))).toBeNull()
  })

  it('returns null for an out-of-alphabet base32 token (0/1/8/9 are excluded)', () => {
    expect(inferTransport('a'.repeat(51) + '0')).toBeNull()
  })
})

describe('validateAgentUrl', () => {
  const notIos = () => false
  const isIos = () => true

  it('accepts wss:// on non-iOS platforms', () => {
    expect(validateAgentUrl('wss://example.com', notIos)).toEqual({ transport: 'websocket' })
  })

  it('accepts ws:// on non-iOS platforms (LAN/dev use)', () => {
    expect(validateAgentUrl('ws://localhost:8080/ws', notIos)).toEqual({ transport: 'websocket' })
  })

  it('rejects http:// with a clear "WebSocket only" message', () => {
    const result = validateAgentUrl('http://example.com/acp', notIos)
    expect('error' in result && result.error).toMatch(/WebSocket|wss:\/\/|ws:\/\//i)
  })

  it('rejects https:// with a clear "WebSocket only" message', () => {
    const result = validateAgentUrl('https://example.com/acp', notIos)
    expect('error' in result && result.error).toMatch(/WebSocket|wss:\/\/|ws:\/\//i)
  })

  it('rejects unsupported schemes with a user-facing message', () => {
    const result = validateAgentUrl('ftp://example.com', notIos)
    expect('error' in result && result.error).toMatch(/WebSocket|wss:\/\/|ws:\/\//i)
  })

  it('rejects ws:// on Tauri iOS (ATS forbids cleartext)', () => {
    const result = validateAgentUrl('ws://example.com', isIos)
    expect('error' in result && result.error).toMatch(/iOS.*secure/i)
  })

  it('still accepts wss:// on Tauri iOS', () => {
    expect(validateAgentUrl('wss://example.com', isIos)).toEqual({ transport: 'websocket' })
  })

  it('accepts a bare iroh NodeId as the iroh transport', () => {
    expect(validateAgentUrl('a'.repeat(52), notIos)).toEqual({ transport: 'iroh' })
  })

  it('accepts an iroh target on iOS (QUIC over an encrypted relay — no ATS concern)', () => {
    expect(validateAgentUrl('a'.repeat(52), isIos)).toEqual({ transport: 'iroh' })
  })
})
