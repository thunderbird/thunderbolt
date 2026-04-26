import { describe, expect, it } from 'bun:test'
import { createWsTicket, consumeWsTicket, validateWsTicketFromUrl } from './ws-ticket'

describe('ws-ticket', () => {
  describe('createWsTicket', () => {
    it('returns a hex string', () => {
      const ticket = createWsTicket('user-123')
      expect(ticket).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns unique tickets', () => {
      const t1 = createWsTicket('user-123')
      const t2 = createWsTicket('user-123')
      expect(t1).not.toBe(t2)
    })
  })

  describe('consumeWsTicket', () => {
    it('returns userId for valid ticket', () => {
      const ticket = createWsTicket('user-456')
      const result = consumeWsTicket(ticket)
      expect(result?.userId).toBe('user-456')
    })

    it('returns null for unknown ticket', () => {
      expect(consumeWsTicket('nonexistent')).toBeNull()
    })

    it('returns null on second use (one-time)', () => {
      const ticket = createWsTicket('user-789')
      expect(consumeWsTicket(ticket)?.userId).toBe('user-789')
      expect(consumeWsTicket(ticket)).toBeNull()
    })

    it('includes payload when provided', () => {
      const ticket = createWsTicket('user-abc', { url: 'http://example.com', authMethod: '{"apiKey":"sk-test"}' })
      const result = consumeWsTicket(ticket)
      expect(result?.userId).toBe('user-abc')
      expect(result?.payload?.url).toBe('http://example.com')
      expect(result?.payload?.authMethod).toBe('{"apiKey":"sk-test"}')
    })

    it('omits payload when not provided', () => {
      const ticket = createWsTicket('user-def')
      const result = consumeWsTicket(ticket)
      expect(result?.payload).toBeUndefined()
    })
  })

  describe('validateWsTicketFromUrl', () => {
    it('extracts and validates ticket from URL query param', () => {
      const ticket = createWsTicket('user-abc')
      expect(validateWsTicketFromUrl(`/ws/chat?ticket=${ticket}`)).toBe('user-abc')
    })

    it('returns null when no ticket param', () => {
      expect(validateWsTicketFromUrl('/ws/chat')).toBeNull()
    })

    it('returns null for invalid ticket in URL', () => {
      expect(validateWsTicketFromUrl('/ws/chat?ticket=bogus')).toBeNull()
    })

    it('consumes ticket — second call returns null', () => {
      const ticket = createWsTicket('user-xyz')
      const url = `/ws/chat?ticket=${ticket}`
      expect(validateWsTicketFromUrl(url)).toBe('user-xyz')
      expect(validateWsTicketFromUrl(url)).toBeNull()
    })
  })
})
