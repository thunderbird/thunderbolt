import { describe, expect, it } from 'bun:test'
import { createWsTicket, consumeWsTicket } from '@/auth/ws-ticket'
import { parseApiKey } from './routes'

describe('parseApiKey', () => {
  it('extracts apiKey from valid JSON', () => {
    expect(parseApiKey('{"apiKey":"sk-test-123"}')).toBe('sk-test-123')
  })

  it('returns null for null input', () => {
    expect(parseApiKey(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseApiKey('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseApiKey('not-json')).toBeNull()
  })

  it('returns null when apiKey is missing from JSON', () => {
    expect(parseApiKey('{"other":"value"}')).toBeNull()
  })
})

describe('ws-ticket integration for agent-proxy', () => {
  it('creates and consumes a valid ticket', () => {
    const ticket = createWsTicket('test-user')
    const result = consumeWsTicket(ticket)
    expect(result?.userId).toBe('test-user')
  })

  it('includes payload when provided', () => {
    const ticket = createWsTicket('test-user', { url: 'http://example.com', authMethod: '{"apiKey":"sk-test"}' })
    const result = consumeWsTicket(ticket)
    expect(result?.payload?.url).toBe('http://example.com')
    expect(result?.payload?.authMethod).toBe('{"apiKey":"sk-test"}')
  })

  it('rejects a consumed ticket on second use', () => {
    const ticket = createWsTicket('test-user')
    consumeWsTicket(ticket)
    expect(consumeWsTicket(ticket)).toBeNull()
  })

  it('rejects an invalid ticket', () => {
    expect(consumeWsTicket('bogus-ticket')).toBeNull()
  })
})
