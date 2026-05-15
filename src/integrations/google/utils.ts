/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
    try {
      // Gmail API returns body.data as base64url, not standard base64
      // See: https://developers.google.com/gmail/api/reference/rest/v1/users.messages
      const base64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/')
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
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

  // Detect if body contains actual HTML tags (not just angle brackets from math/code)
  const isHtml = /<[a-z][a-z0-9]*(?:\s[^>]*)?\/?>/i.test(params.body)
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

  const emailContent = parts.join('\r\n')
  const bytes = new TextEncoder().encode(emailContent)
  return btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
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
