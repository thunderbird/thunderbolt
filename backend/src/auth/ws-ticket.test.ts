import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { clearTickets, consumeWsTicket, createWsTicket, TicketQuotaError } from './ws-ticket'

describe('ws-ticket', () => {
  beforeEach(() => {
    clearTickets()
  })

  it('returns null when the ticket has expired', () => {
    const nowSpy = spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    const ticket = createWsTicket('user-1')
    nowSpy.mockReturnValue(1_000_000 + 30_001) // past TTL
    expect(consumeWsTicket(ticket)).toBeNull()
    nowSpy.mockRestore()
  })

  it('throws when ticket store is at capacity', () => {
    const nowSpy = spyOn(Date, 'now')
    // Freeze time so the eviction pass (triggered at MAX_TICKETS/2) finds
    // nothing expired and the store fills to exactly MAX_TICKETS.
    nowSpy.mockReturnValue(1_000_000)
    for (let i = 0; i < 10_000; i++) {
      createWsTicket(`user-${i}`)
    }
    expect(() => createWsTicket('overflow')).toThrow('Ticket store at capacity')
    nowSpy.mockRestore()
  })

  it('generates a 64-character hex ticket', () => {
    const ticket = createWsTicket('user-1')
    expect(ticket).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(ticket)).toBe(true)
  })

  it('generates unique tickets', () => {
    const tickets = new Set(Array.from({ length: 100 }, (_, i) => createWsTicket(`user-${i}`)))
    expect(tickets.size).toBe(100)
  })

  it('consumes a valid ticket and returns userId', () => {
    const ticket = createWsTicket('user-42')
    const result = consumeWsTicket(ticket)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe('user-42')
  })

  it('returns null on second consumption (one-time use)', () => {
    const ticket = createWsTicket('user-1')
    const first = consumeWsTicket(ticket)
    expect(first).not.toBeNull()
    const second = consumeWsTicket(ticket)
    expect(second).toBeNull()
  })

  it('returns null for unknown ticket', () => {
    const result = consumeWsTicket('0'.repeat(64))
    expect(result).toBeNull()
  })

  it('roundtrips payload', () => {
    const payload = { url: 'wss://example.com', authMethod: '{"apiKey":"abc"}' }
    const ticket = createWsTicket('user-1', payload)
    const result = consumeWsTicket(ticket)
    expect(result).not.toBeNull()
    expect(result!.payload).toEqual(payload)
  })

  it('omits payload when not provided', () => {
    const ticket = createWsTicket('user-1')
    const result = consumeWsTicket(ticket)
    expect(result).not.toBeNull()
    expect(result!.payload).toBeUndefined()
  })

  it('handles high-volume ticket creation without errors', () => {
    // Create more than MAX_TICKETS/2 to trigger eviction
    const tickets: string[] = []
    for (let i = 0; i < 6000; i++) {
      tickets.push(createWsTicket(`user-${i}`))
    }
    // The most recent ticket should still be consumable
    const lastTicket = tickets[tickets.length - 1]
    const result = consumeWsTicket(lastTicket)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe('user-5999')
  })

  it('throws TicketQuotaError after 20 tickets for same user', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const userId = 'user-quota'
    const tickets: string[] = []
    for (let i = 0; i < 20; i++) {
      tickets.push(createWsTicket(userId))
    }
    expect(tickets).toHaveLength(20)
    expect(() => createWsTicket(userId)).toThrow(TicketQuotaError)
    warnSpy.mockRestore()
  })

  it('TicketQuotaError has retryAfterSecs = 30', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const userId = 'user-retry'
    for (let i = 0; i < 20; i++) {
      createWsTicket(userId)
    }
    try {
      createWsTicket(userId)
      throw new Error('expected TicketQuotaError')
    } catch (err) {
      expect(err).toBeInstanceOf(TicketQuotaError)
      expect((err as TicketQuotaError).retryAfterSecs).toBe(30)
    }
    warnSpy.mockRestore()
  })

  it('different users have independent quotas', () => {
    for (let i = 0; i < 20; i++) {
      createWsTicket('user-a')
    }
    // user-a is at quota, user-b should still be able to create
    expect(() => createWsTicket('user-b')).not.toThrow()
  })

  it('expired tickets do not count toward quota', () => {
    const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000_000)
    for (let i = 0; i < 20; i++) {
      createWsTicket('user-expired')
    }
    // Advance past TTL
    nowSpy.mockReturnValue(1_000_000 + 31_000)
    // Old tickets expired → should be able to create more
    expect(() => createWsTicket('user-expired')).not.toThrow()
    nowSpy.mockRestore()
  })
})
