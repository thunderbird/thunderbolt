/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import type { McpServer } from '@/types'
import { cleanServerUrl, serverDisplayName, serverMatchesQuery } from './display'

const server = (overrides: Partial<McpServer>): McpServer => ({ id: 'server-1', ...overrides }) as McpServer

describe('cleanServerUrl', () => {
  it('strips the protocol and trailing slash', () => {
    expect(cleanServerUrl('https://api.example.com/mcp/')).toBe('api.example.com/mcp')
    expect(cleanServerUrl('http://localhost:3000/')).toBe('localhost:3000')
  })

  it('keeps the port and path', () => {
    expect(cleanServerUrl('https://api.example.com:8443/v1/mcp')).toBe('api.example.com:8443/v1/mcp')
  })

  it('returns a non-URL target (e.g. an iroh NodeId) as-is', () => {
    const nodeId = 'a'.repeat(52)
    expect(cleanServerUrl(nodeId)).toBe(nodeId)
  })

  it('falls back to stripping a bare protocol prefix when URL parsing fails', () => {
    expect(cleanServerUrl('https://')).toBe('')
  })
})

describe('serverDisplayName', () => {
  it('prefers the server name', () => {
    expect(serverDisplayName(server({ name: 'My Server', url: 'https://api.example.com' }))).toBe('My Server')
  })

  it('falls back to the cleaned URL when the name is empty', () => {
    expect(serverDisplayName(server({ name: '', url: 'https://api.example.com/mcp/' }))).toBe('api.example.com/mcp')
  })

  it('handles a missing URL', () => {
    expect(serverDisplayName(server({ name: '', url: null }))).toBe('')
  })
})

describe('serverMatchesQuery', () => {
  const github = server({ name: 'GitHub Tools', url: 'https://api.github.com/mcp' })

  it('matches everything on an empty query', () => {
    expect(serverMatchesQuery(github, '')).toBe(true)
  })

  it('matches name and URL case-insensitively', () => {
    expect(serverMatchesQuery(github, 'github')).toBe(true)
    expect(serverMatchesQuery(github, 'TOOLS')).toBe(true)
    expect(serverMatchesQuery(github, 'api.github')).toBe(true)
    expect(serverMatchesQuery(github, 'gitlab')).toBe(false)
  })

  it('tolerates null name and url', () => {
    expect(serverMatchesQuery(server({ name: null as unknown as string, url: null }), 'anything')).toBe(false)
  })
})
