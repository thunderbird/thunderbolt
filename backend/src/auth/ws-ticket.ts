import type { Auth } from './auth'

type WsTicket = {
  userId: string
  expiresAt: number
  payload?: Record<string, unknown>
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
export const createWsTicket = (userId: string, payload?: Record<string, unknown>): string => {
  if (tickets.size > MAX_TICKETS / 2) {
    evictExpired()
  }

  const ticketId = generateTicketId()
  tickets.set(ticketId, {
    userId,
    expiresAt: Date.now() + TICKET_TTL_MS,
    ...(payload ? { payload } : {}),
  })
  return ticketId
}

/**
 * Validates and consumes a WebSocket ticket. Returns the userId if valid,
 * null if the ticket is invalid, expired, or already consumed.
 */
export const consumeWsTicket = (ticketId: string): { userId: string; payload?: Record<string, unknown> } | null => {
  const ticket = tickets.get(ticketId)
  if (!ticket) {
    return null
  }

  tickets.delete(ticketId)

  if (Date.now() > ticket.expiresAt) {
    return null
  }

  return { userId: ticket.userId, payload: ticket.payload }
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
    return consumeWsTicket(ticketId)?.userId ?? null
  } catch {
    return null
  }
}
