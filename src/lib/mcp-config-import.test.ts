/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { parseMcpServersConfig } from './mcp-config-import'

describe('parseMcpServersConfig', () => {
  it('parses a single mcpServers entry into one server', () => {
    const result = parseMcpServersConfig(JSON.stringify({ mcpServers: { Acme: { url: 'https://acme.example/mcp' } } }))

    expect(result).toEqual({
      ok: true,
      servers: [
        { name: 'Acme', url: 'https://acme.example/mcp', transport: 'http', credential: undefined, enabled: true },
      ],
    })
  })

  it('accepts the VS Code "servers" root variant', () => {
    const result = parseMcpServersConfig(JSON.stringify({ servers: { Acme: { url: 'https://acme.example/mcp' } } }))

    expect(result.ok).toBe(true)
    expect(result.ok && result.servers).toHaveLength(1)
  })

  it('parses multiple entries into N servers', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({
        mcpServers: {
          One: { url: 'https://one.example/mcp' },
          Two: { url: 'https://two.example/mcp' },
          Three: { url: 'https://three.example/mcp' },
        },
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.servers.map((s) => s.name)).toEqual(['One', 'Two', 'Three'])
  })

  it('rejects stdio entries with a command', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({ mcpServers: { Local: { command: 'node', args: ['server.js'] } } }),
    )

    expect(result).toEqual({
      ok: false,
      errors: ['Local: local/stdio servers are not supported yet (coming in THU-575)'],
    })
  })

  it('rejects stdio entries that only have args', () => {
    const result = parseMcpServersConfig(JSON.stringify({ mcpServers: { Local: { args: ['--stdio'] } } }))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors[0]).toContain('THU-575')
  })

  it('rejects a public http url', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({ mcpServers: { Insecure: { url: 'http://acme.example/mcp' } } }),
    )

    expect(result).toEqual({
      ok: false,
      errors: ['Insecure: Use https:// (http is only allowed for localhost or a local network)'],
    })
  })

  it('preserves the type field as transport when valid', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({ mcpServers: { Streamy: { url: 'https://s.example/mcp', type: 'sse' } } }),
    )

    expect(result.ok && result.servers[0].transport).toBe('sse')
  })

  it('defaults transport to http for unknown type values', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({ mcpServers: { Weird: { url: 'https://w.example/mcp', type: 'stdio' } } }),
    )

    expect(result.ok && result.servers[0].transport).toBe('http')
  })

  it('extracts a Bearer Authorization header into a bearer credential', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({
        mcpServers: { Auth: { url: 'https://auth.example/mcp', headers: { Authorization: 'Bearer secret-token' } } },
      }),
    )

    expect(result.ok && result.servers[0].credential).toEqual({ type: 'bearer', token: 'secret-token' })
  })

  it('matches Bearer case-insensitively', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({
        mcpServers: { Auth: { url: 'https://auth.example/mcp', headers: { Authorization: 'bearer lower' } } },
      }),
    )

    expect(result.ok && result.servers[0].credential).toEqual({ type: 'bearer', token: 'lower' })
  })

  it('ignores non-Bearer headers but still parses the server', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({
        mcpServers: { ApiKey: { url: 'https://k.example/mcp', headers: { 'X-Api-Key': 'abc123' } } },
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.servers[0].credential).toBeUndefined()
  })

  it('maps disabled:true to enabled:false', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({ mcpServers: { Off: { url: 'https://off.example/mcp', disabled: true } } }),
    )

    expect(result.ok && result.servers[0].enabled).toBe(false)
  })

  it('treats disabled:false (and absence) as enabled', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({ mcpServers: { On: { url: 'https://on.example/mcp', disabled: false } } }),
    )

    expect(result.ok && result.servers[0].enabled).toBe(true)
  })

  it('returns an error for malformed JSON', () => {
    const result = parseMcpServersConfig('{ not json')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors[0]).toStartWith('Invalid JSON:')
  })

  it('errors when neither mcpServers nor servers is present', () => {
    const result = parseMcpServersConfig(JSON.stringify({ foo: 'bar' }))

    expect(result.ok).toBe(false)
  })

  it('errors on an empty mcpServers object', () => {
    const result = parseMcpServersConfig(JSON.stringify({ mcpServers: {} }))

    expect(result.ok).toBe(false)
  })

  it('fails all-or-nothing when one entry among many is bad', () => {
    const result = parseMcpServersConfig(
      JSON.stringify({
        mcpServers: {
          Good: { url: 'https://good.example/mcp' },
          Bad: { url: 'http://bad.example/mcp' },
        },
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors).toEqual([
      'Bad: Use https:// (http is only allowed for localhost or a local network)',
    ])
  })
})
