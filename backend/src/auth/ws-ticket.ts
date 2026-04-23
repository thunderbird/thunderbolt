type WsTicket = {
  userId: string
  expiresAt: number
  payload?: Record<string, unknown>
}

const TICKET_TTL_MS = 30_000 // 30 seconds
const MAX_TICKETS = 10_000
const maxTicketsPerUser = 20

// In-memory store — single-process only. For multi-process, use Redis.
const tickets = new Map<string, WsTicket>()

/** Thrown when a user has reached their per-session ticket quota. Maps to HTTP 429. */
export class TicketQuotaError extends Error {
  readonly retryAfterSecs = 30
  constructor(userId: string) {
    super(`Ticket quota exceeded for user ${userId}`)
    this.name = 'TicketQuotaError'
  }
}

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

/** Count active (unexpired, unconsumed) tickets for a given userId. */
const countActiveTicketsForUser = (userId: string, now: number): number => {
  let count = 0
  for (const ticket of tickets.values()) {
    if (ticket.userId === userId && ticket.expiresAt > now) {
      count++
    }
  }
  return count
}

/**
 * Creates a short-lived, one-time-use ticket for WebSocket authentication.
 * The ticket is consumed on first use and expires after TICKET_TTL_MS.
 * Throws {@link TicketQuotaError} when the per-user quota is exceeded.
 */
export const createWsTicket = (userId: string, payload?: Record<string, unknown>): string => {
  if (tickets.size >= MAX_TICKETS / 2) {
    evictExpired()
  }
  if (tickets.size >= MAX_TICKETS) {
    throw new Error('Ticket store at capacity')
  }

  const now = Date.now()
  const userTicketCount = countActiveTicketsForUser(userId, now)
  if (userTicketCount >= maxTicketsPerUser) {
    console.warn(`[ws-ticket] User ${userId} hit per-user quota (active=${userTicketCount}, max=${maxTicketsPerUser})`)
    throw new TicketQuotaError(userId)
  }

  const ticketId = generateTicketId()
  tickets.set(ticketId, {
    userId,
    expiresAt: now + TICKET_TTL_MS,
    ...(payload ? { payload } : {}),
  })
  return ticketId
}

/**
 * Validates and consumes a WebSocket ticket. Returns the userId and optional payload
 * if valid, null if the ticket is invalid, expired, or already consumed.
 */
export const consumeWsTicket = (ticketId: string): { userId: string; payload?: Record<string, unknown> } | null => {
  const ticket = tickets.get(ticketId)
  if (!ticket) return null

  tickets.delete(ticketId)

  if (Date.now() > ticket.expiresAt) return null

  return { userId: ticket.userId, payload: ticket.payload }
}

/** Clears the in-memory ticket store. Used by tests to isolate state between test runs. */
export const clearTickets = (): void => {
  tickets.clear()
}
