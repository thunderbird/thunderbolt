import { refreshAccessToken } from '@/lib/auth'
import type { HttpClient } from '@/lib/http'
import { getSettings, updateSettings } from '@/dal'
import { getDb } from '@/db/database'
import type { DraftEmailParams } from './tools'

// =============================================================================
// EMAIL UTILITY FUNCTIONS
// =============================================================================

/**
 * Parse email address from Gmail API format
 */
export const parseEmailAddress = (emailStr: string): { name: string; email: string } => {
  if (!emailStr) {
    return { name: '', email: '' }
  }

  // Handle formats like "John Doe <john@example.com>" or just "john@example.com"
  const match = emailStr.match(/^(.+?)\s*<(.+)>$/)
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() }
  }
  return { name: '', email: emailStr.trim() }
}

/**
 * Extract header value from Gmail message
 */
export const getHeader = (message: any, name: string): string => {
  if (!message?.payload?.headers) {
    return ''
  }
  const header = message.payload.headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
  return header?.value || ''
}

/**
 * Extract body from Gmail message payload
 */
export const extractBody = (payload: any, mimeType: string): string => {
  if (!payload) {
    return ''
  }

  if (payload.mimeType === mimeType && payload.body?.data) {
    // Use browser-compatible base64 decoding instead of Node.js Buffer
    try {
      return decodeURIComponent(escape(atob(payload.body.data)))
    } catch (error) {
      console.warn('Failed to decode email body:', error)
      return ''
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const body = extractBody(part, mimeType)
      if (body) {
        return body
      }
    }
  }

  return ''
}

/**
 * Build raw email message for drafts
 */
export const buildRawMessage = (params: DraftEmailParams): string => {
  const parts: string[] = []

  parts.push('From: me')

  // Handle recipients
  const toAddresses = Array.isArray(params.to) ? params.to.join(', ') : params.to
  parts.push(`To: ${toAddresses}`)

  if (params.cc) {
    const ccAddresses = Array.isArray(params.cc) ? params.cc.join(', ') : params.cc
    parts.push(`Cc: ${ccAddresses}`)
  }

  if (params.bcc) {
    const bccAddresses = Array.isArray(params.bcc) ? params.bcc.join(', ') : params.bcc
    parts.push(`Bcc: ${bccAddresses}`)
  }

  parts.push(`Subject: ${params.subject}`)
  parts.push('MIME-Version: 1.0')

  // Detect if body contains HTML
  const isHtml = params.body.includes('<') && params.body.includes('>')
  if (isHtml) {
    parts.push('Content-Type: text/html; charset="UTF-8"')
  } else {
    parts.push('Content-Type: text/plain; charset="UTF-8"')
  }

  parts.push('')

  // Convert various line break formats to proper email line breaks
  const processedBody = params.body
    .replace(/\\n\\n/g, '\r\n\r\n') // Literal \n\n strings
    .replace(/\\n/g, '\r\n') // Literal \n strings
    .replace(/\n\n/g, '\r\n\r\n') // Actual double newlines
    .replace(/\n/g, '\r\n') // Actual single newlines

  parts.push(processedBody)

  // Use browser-compatible base64 encoding instead of Node.js Buffer
  const emailContent = parts.join('\r\n')
  return btoa(unescape(encodeURIComponent(emailContent)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

// =============================================================================
// AUTH UTILITY FUNCTIONS
// =============================================================================

/**
 * Retrieve stored Google OAuth credentials from settings.
 * Throws if the integration has not been connected yet or the stored value is malformed.
 */
export const getGoogleCredentials = async (): Promise<{
  access_token: string
  refresh_token?: string
  expires_at?: number
}> => {
  const db = getDb()
  const settings = await getSettings(db, { integrations_google_credentials: String })
  const credentialsStr = settings.integrationsGoogleCredentials
  if (!credentialsStr) {
    throw new Error('Google integration not connected')
  }

  try {
    return JSON.parse(credentialsStr)
  } catch {
    throw new Error('Invalid Google credentials')
  }
}

/**
 * Ensure that we have a valid Google OAuth access token, refreshing it if necessary.
 * If the token is refreshed, the stored credentials are updated automatically.
 */
export const ensureValidGoogleToken = async (
  httpClient: HttpClient,
  credentials: {
    access_token: string
    refresh_token?: string
    expires_at?: number
  },
): Promise<string> => {
  const now = Date.now()
  // If the token is still valid for at least 1 minute, reuse it
  if (credentials.expires_at && credentials.expires_at - 60_000 > now) {
    return credentials.access_token
  }

  if (!credentials.refresh_token) {
    throw new Error('Access token expired and no refresh token available')
  }

  const newTokens = await refreshAccessToken(httpClient, 'google', credentials.refresh_token)

  const updated = {
    ...credentials,
    access_token: newTokens.access_token,
    expires_at: Date.now() + newTokens.expires_in * 1000,
  }

  const db = getDb()
  await updateSettings(db, { integrations_google_credentials: JSON.stringify(updated) })

  return updated.access_token
}

// =============================================================================
// DRIVE UTILITY FUNCTIONS
// =============================================================================

/**
 * Validates and passes through Google Drive API search queries without transformation
 *
 * This function expects queries to use Google's native Drive API syntax.
 * The LLM should generate proper syntax based on the comprehensive documentation
 * provided in the searchDriveSchema.
 *
 * @param query - Google Drive API search query using native syntax
 * @returns The trimmed query string, or empty string for blank input
 *
 * @example
 * // Valid query formats:
 * transformDriveQuery("name contains 'report'")
 * transformDriveQuery("mimeType = 'application/pdf' and trashed = false")
 * transformDriveQuery("(name contains 'budget') or (fullText contains 'finance')")
 */
export const transformDriveQuery = (query: string): string => {
  if (!query.trim()) {
    return ''
  }

  // Return the query as-is - the LLM should generate proper Google Drive API syntax
  return query.trim()
}
