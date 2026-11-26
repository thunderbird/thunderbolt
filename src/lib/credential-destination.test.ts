/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isSameCredentialDestination, isSameModelKeyDestination } from './credential-destination'

describe('isSameCredentialDestination', () => {
  it.each([
    ['https://mcp.example.com/mcp', 'HTTPS://MCP.Example.COM/mcp'],
    ['https://mcp.example.com', 'https://mcp.example.com/'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com:443/mcp'],
    ['http://localhost:80/mcp', 'http://localhost/mcp'],
    ['https://mcp.example.com/a/../mcp', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp#tools', ' https://mcp.example.com/mcp '],
  ])('treats %s and %s as one destination', (approved, target) => {
    expect(isSameCredentialDestination(approved, target)).toBe(true)
  })

  it.each([
    ['https://mcp.example.com/mcp', 'http://mcp.example.com/mcp'],
    ['https://mcp.example.com/mcp', 'https://evil.example.com/mcp'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com.evil.test/mcp'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com:8443/mcp'],
    ['https://mcp.example.com/tenant-a/mcp', 'https://mcp.example.com/tenant-b/mcp'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp?tenant=b'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/'],
    ['https://mcp.example.com/mcp', 'https://user@mcp.example.com/mcp'],
  ])('treats %s and %s as different destinations', (approved, target) => {
    expect(isSameCredentialDestination(approved, target)).toBe(false)
  })

  it('never matches a missing or unparseable URL, even against itself', () => {
    expect(isSameCredentialDestination(undefined, undefined)).toBe(false)
    expect(isSameCredentialDestination(null, 'https://mcp.example.com/mcp')).toBe(false)
    expect(isSameCredentialDestination('not a url', 'not a url')).toBe(false)
  })
})

describe('isSameModelKeyDestination', () => {
  it('compares Custom models by their normalized base URL', () => {
    const saved = { provider: 'custom' as const, url: 'https://llm.example.com' }
    expect(isSameModelKeyDestination(saved, { provider: 'custom', url: 'https://llm.example.com/v1/' })).toBe(true)
    expect(isSameModelKeyDestination(saved, { provider: 'custom', url: 'https://evil.example.com/v1' })).toBe(false)
    expect(isSameModelKeyDestination(saved, { provider: 'custom', url: null })).toBe(false)
  })

  it('names a hosted provider by the provider alone', () => {
    expect(isSameModelKeyDestination({ provider: 'openai', url: null }, { provider: 'openai', url: 'x' })).toBe(true)
    expect(isSameModelKeyDestination({ provider: 'openai', url: null }, { provider: 'openrouter', url: null })).toBe(
      false,
    )
    expect(
      isSameModelKeyDestination(
        { provider: 'openai', url: null },
        { provider: 'custom', url: 'https://api.openai.com' },
      ),
    ).toBe(false)
  })

  it('never matches an unbound key', () => {
    expect(isSameModelKeyDestination({ provider: null, url: null }, { provider: null, url: null })).toBe(false)
  })
})
