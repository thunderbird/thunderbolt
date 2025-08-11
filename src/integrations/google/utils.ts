// Debug: Log when utils.ts is loaded
console.log('utils.ts: Loading module')

import { refreshAccessToken } from '../../lib/auth'
import { getSetting, updateSetting } from '../../lib/dal'
import type { DraftEmailParams } from './tools'

// Debug: Check if imports worked
console.log('utils.ts: refreshAccessToken type:', typeof refreshAccessToken)
console.log('utils.ts: getSetting type:', typeof getSetting)
console.log('utils.ts: updateSetting type:', typeof updateSetting)

// =============================================================================
// EMAIL UTILITY FUNCTIONS
// =============================================================================

/**
 * Parse email address from Gmail API format
 */
export const parseEmailAddress = (emailStr: string): { name: string; email: string } => {
  if (!emailStr) return { name: '', email: '' }

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
  if (!message?.payload?.headers) return ''
  const header = message.payload.headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
  return header?.value || ''
}

/**
 * Extract body from Gmail message payload
 */
export const extractBody = (payload: any, mimeType: string): string => {
  if (!payload) return ''

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
      if (body) return body
    }
  }

  return ''
}

/**
 * Truncate text to reasonable length for LLMs
 */
export const truncateText = (text: string, maxLength = 4000): string => {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...[truncated]'
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
  const credentialsStr = await getSetting('integrations_google_credentials')
  if (!credentialsStr) throw new Error('Google integration not connected')

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
export const ensureValidGoogleToken = async (credentials: {
  access_token: string
  refresh_token?: string
  expires_at?: number
}): Promise<string> => {
  const now = Date.now()
  // If the token is still valid for at least 1 minute, reuse it
  if (credentials.expires_at && credentials.expires_at - 60_000 > now) {
    return credentials.access_token
  }

  if (!credentials.refresh_token) throw new Error('Access token expired and no refresh token available')

  const newTokens = await refreshAccessToken('google', credentials.refresh_token)

  const updated = {
    ...credentials,
    access_token: newTokens.access_token,
    expires_at: Date.now() + newTokens.expires_in * 1000,
  }

  await updateSetting('integrations_google_credentials', JSON.stringify(updated))

  return updated.access_token
}

// =============================================================================
// DRIVE UTILITY FUNCTIONS
// =============================================================================

/**
 * Transforms a user-friendly search query into a valid Google Drive API query
 * Handles conversions like:
 * - name:foo -> name contains 'foo'
 * - type:document -> mimeType='application/vnd.google-apps.document'
 * - modifiedTime>2024-01-01 -> modifiedTime>'2024-01-01T00:00:00Z'
 */
export const transformDriveQuery = (query: string): string => {
  if (!query.trim()) return ''

  // A more robust way to split the query string by spaces, while respecting quoted content.
  const parts = query.match(/('.*?'|[^'\s]+)+(?=\s*|\s*$)/g) || []

  const typeMapping: Record<string, string> = {
    document: 'application/vnd.google-apps.document',
    spreadsheet: 'application/vnd.google-apps.spreadsheet',
    presentation: 'application/vnd.google-apps.presentation',
    drawing: 'application/vnd.google-apps.drawing',
    folder: 'application/vnd.google-apps.folder',
    pdf: 'application/pdf',
    image: 'image/',
    video: 'video/',
    audio: 'audio/',
    text: 'text/',
  }

  const transformedParts = parts.map((part) => {
    // Note: The order of replacements is important.
    // 1. Transform name shorthand (e.g., name:doc) to "name contains 'doc'"
    let transformed = part.replace(/name:'([^']+)'/g, "name contains '$1'")
    transformed = transformed.replace(/name:([^\s"']+)/g, "name contains '$1'")

    // 2. Transform type shorthand (e.g., type:pdf) to the correct mimeType query
    transformed = transformed.replace(/type:([^\s]+)/g, (_m, raw) => {
      const key = raw.toLowerCase()
      const mime = typeMapping[key] ?? raw
      if (mime.endsWith('/')) {
        return `mimeType contains '${mime}'`
      }
      return `mimeType='${mime}'`
    })

    // 3. Transform dates (YYYY-MM-DD to RFC-3339) and wrap in quotes
    transformed = transformed.replace(
      /(modifiedTime|createdTime)\s*([><=]+)\s*(\d{4}-\d{2}-\d{2})(?!T)/g,
      (_m, field, op, date) => `${field}${op}'${date}T00:00:00Z'`,
    )

    // 4. Quote existing RFC-3339 timestamps if they are not already quoted
    transformed = transformed.replace(
      /(modifiedTime|createdTime)\s*([><=]+)\s*'?"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)'?"?/g,
      (_m, field, op, ts) => `${field}${op}'${ts}'`,
    )

    return transformed
  })

  return transformedParts.join(' and ')
}
