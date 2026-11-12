/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { getMemoryMcpProvider, memoryMcpProviders, memoryMcpServerUrl, memoryMcpTransportUrl } from './providers'

test.each(memoryMcpProviders)('classifies $name by its trusted endpoint', (provider) => {
  expect(getMemoryMcpProvider(provider.url)?.id).toBe(provider.id)
  expect(getMemoryMcpProvider(`${provider.url}/?scope=read`)?.id).toBe(provider.id)
  const encoded = new URL(provider.url)
  encoded.pathname = '/%6dcp'
  expect(getMemoryMcpProvider(encoded.href)?.id).toBe(provider.id)
  encoded.pathname = '/alternate-memory-endpoint'
  expect(getMemoryMcpProvider(encoded.href)?.id).toBe(provider.id)
  expect(getMemoryMcpProvider(provider.url.replace('https:', 'http:'))).toBeUndefined()
  const attacker = new URL(provider.url)
  attacker.hostname += '.attacker.example'
  expect(getMemoryMcpProvider(attacker.href)).toBeUndefined()
})

test.each([
  null,
  undefined,
  '',
  'Supermemory',
  'https://example.com/mcp',
  'https://mcp.mem0.ai.attacker.example/mcp',
  'https://mcp.mem0.ai:8443/mcp',
])('does not classify an unrelated endpoint: %s', (url) => {
  expect(getMemoryMcpProvider(url)).toBeUndefined()
})

test('Hindsight requires one explicit, URL-safe bank; root and bank endpoints both gate as memory', () => {
  const provider = memoryMcpProviders.find(({ id }) => id === 'hindsight')!
  expect(memoryMcpServerUrl(provider, 'team-notes_42')).toBe('https://api.hindsight.vectorize.io/mcp/team-notes_42/')
  expect(getMemoryMcpProvider(memoryMcpServerUrl(provider, 'team-notes_42'))?.id).toBe('hindsight')
  for (const bank of ['', '../other', 'one/two', 'bank?token=secret', 'bank#fragment']) {
    expect(() => memoryMcpServerUrl(provider, bank)).toThrow()
  }
})

test('fixed providers use their documented endpoint without a bank suffix', () => {
  for (const provider of memoryMcpProviders.filter(({ bankScoped }) => !bankScoped)) {
    expect(memoryMcpServerUrl(provider)).toBe(provider.url)
  }
})

test('Mem0 uses its canonical POST endpoint, including previously saved URLs', () => {
  const provider = memoryMcpProviders.find(({ id }) => id === 'mem0')!
  expect(memoryMcpServerUrl(provider)).toBe('https://mcp.mem0.ai/mcp/')
  expect(memoryMcpTransportUrl('https://mcp.mem0.ai/mcp')).toBe(provider.url)
  expect(memoryMcpTransportUrl('https://mcp.mem0.ai/mcp?scope=read')).toBe(`${provider.url}?scope=read`)
  expect(getMemoryMcpProvider('https://mcp.mem0.ai/mcp')?.id).toBe('mem0')
})

test.each([
  'https://mcp.mem0.ai/mcp/',
  'https://mcp.mem0.ai/other',
  'https://mcp.mem0.ai/%6dcp',
  'https://mcp.mem0.ai:8443/mcp',
  'http://mcp.mem0.ai/mcp',
  'https://mcp.mem0.ai.attacker.example/mcp',
  'https://api.getzep.com/mcp',
  'https://api.hindsight.vectorize.io/mcp/personal/',
])('does not rewrite unrelated or already canonical transport URLs: %s', (url) => {
  expect(memoryMcpTransportUrl(url)).toBe(url)
})
