/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isLoopbackHost, isLoopbackUrl } from './is-loopback'

describe('isLoopbackHost', () => {
  it('classifies the four loopback hostnames', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true)
    expect(isLoopbackHost('LocalHost')).toBe(true)
  })

  it('accepts a bracketed IPv6 literal (the form URL.hostname yields)', () => {
    expect(isLoopbackHost('[::1]')).toBe(true)
  })

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('agent.example.com')).toBe(false)
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    expect(isLoopbackHost('::2')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })

  it('does not treat a name merely containing "localhost" as loopback', () => {
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
    expect(isLoopbackHost('notlocalhost')).toBe(false)
  })
})

describe('isLoopbackUrl', () => {
  it('classifies the bridge ACP/MCP shorthand the bridge prints', () => {
    // Exactly the STDERR shapes: `ws://127.0.0.1:PORT` (ACP), `http://127.0.0.1:PORT/mcp` (MCP).
    expect(isLoopbackUrl('ws://127.0.0.1:8080')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:9000/mcp')).toBe(true)
  })

  it('canonicalizes shorthand: ports, paths, and casing do not matter', () => {
    expect(isLoopbackUrl('http://localhost:3000/mcp')).toBe(true)
    expect(isLoopbackUrl('ws://0.0.0.0:1234')).toBe(true)
    expect(isLoopbackUrl('http://LOCALHOST/x')).toBe(true)
  })

  it('classifies IPv6 loopback whether bracketed in the URL or not', () => {
    expect(isLoopbackUrl('ws://[::1]:8080')).toBe(true)
    expect(isLoopbackUrl('http://[::1]/mcp')).toBe(true)
  })

  it('rejects remote endpoints', () => {
    expect(isLoopbackUrl('wss://agent.example.com/acp')).toBe(false)
    expect(isLoopbackUrl('https://mcp.example.com/server')).toBe(false)
    expect(isLoopbackUrl('ws://10.0.0.1:8080')).toBe(false)
  })

  it('treats a malformed URL as not loopback', () => {
    expect(isLoopbackUrl('not a url')).toBe(false)
    expect(isLoopbackUrl('')).toBe(false)
  })
})
