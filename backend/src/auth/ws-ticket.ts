import type { Auth } from './auth'

type WsTicket = {
  userId: string
  expiresAt: number
}

const TICKET_TTL_MS = 30_000 // 30 seconds
const MAX_TICKETS = 10_000

// In-memory store — single-process only. For multi-process, use Redis.
const tickets = new Map<string, WsTicket>()

const generateTicketId = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const evictExpired = () => {
  const now = Date.now()
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) {
      tickets.delete(id)
    }
  }
}

/**
 * Creates a short-lived, one-time-use ticket for WebSocket authentication.
 * The ticket is consumed on first use and expires after TICKET_TTL_MS.
 */
export const createWsTicket = (userId: string): string => {
  // Evict expired tickets periodically to prevent unbounded growth
  if (tickets.size > MAX_TICKETS / 2) {
    evictExpired()
  }

  const ticketId = generateTicketId()
  tickets.set(ticketId, {
    userId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  })
  return ticketId
}

/**
 * Validates and consumes a WebSocket ticket. Returns the userId if valid,
 * null if the ticket is invalid, expired, or already consumed.
 */
export const consumeWsTicket = (ticketId: string): string | null => {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return null
  }

  // One-time use — delete immediately
  tickets.delete(ticketId)

  if (Date.now() > ticket.expiresAt) {
    return null
  }

  return ticket.userId
}

/**
 * Validates a WebSocket ticket from a URL query string.
 * Extracts the `ticket` param, consumes it, and returns the userId.
 * Returns null if no ticket or invalid.
 */
export const validateWsTicketFromUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url, 'http://localhost')
    const ticketId = parsed.searchParams.get('ticket')
    if (!ticketId) {
      return null
    }
    return consumeWsTicket(ticketId)
  } catch {
    return null
  }
}
