import { http } from '@/lib/http'
import { getDb } from '@/db/database'
import { getSettings } from '@/dal'
import { getAuthToken } from '@/lib/auth-token'

/**
 * Fetches a one-time WebSocket authentication ticket from the backend.
 * The ticket is short-lived (30s) and consumed on first use.
 */
export const fetchWsTicket = async (payload?: Record<string, unknown>): Promise<string> => {
  const db = getDb()
  const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })
  const token = getAuthToken()
  const data = await http
    .post(`${cloudUrl}/ws-ticket`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
      ...(payload ? { json: { payload } } : {}),
    })
    .json<{ ticket: string }>()
  return data.ticket
}

/**
 * Appends a WebSocket auth ticket to a URL as a query parameter.
 */
export const appendTicketToUrl = (url: string, ticket: string): string => {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}ticket=${ticket}`
}
