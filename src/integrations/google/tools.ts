import { llmContentCharLimit, truncateText } from '@/lib/utils'
import type { ToolConfig } from '@/types'
import { http, type HttpClient } from '@/lib/http'
import { z } from 'zod'
import {
  buildRawMessage,
  ensureValidGoogleToken,
  extractBody,
  getGoogleCredentials,
  getHeader,
  parseEmailAddress,
  transformDriveQuery,
} from './utils'

// =============================================================================
// SCHEMAS
// =============================================================================

export const checkInboxSchema = z
  .object({
    label: z
      .string()
      .optional()
      .default('INBOX')
      .describe('Gmail label/folder to check (INBOX, SENT, DRAFTS, or custom labels)'),
    max_results: z
      .number()
      .optional()
      .default(20)
      .describe('Maximum number of conversations to return (default: 20, max: 50)'),
    include_spam_trash: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include conversations from SPAM and TRASH folders'),
  })
  .strict()

export const searchEmailsSchema = z
  .object({
    query: z
      .string()
      .describe('Gmail search query (supports Gmail search syntax like "from:example.com subject:important")'),
    max_results: z
      .number()
      .optional()
      .default(20)
      .describe('Maximum number of emails to return (default: 20, max: 50)'),
  })
  .strict()

export const getEmailSchema = z
  .object({
    id: z.string().describe('The email message ID to retrieve'),
  })
  .strict()

export const draftEmailSchema = z
  .object({
    to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body content (plain text or HTML)'),
    cc: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('CC recipients (optional)'),
    bcc: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('BCC recipients (optional)'),
    reply_to_id: z.string().optional().describe('ID of email to reply to (optional)'),
    reply_all: z.boolean().optional().describe('Whether to reply to all recipients (default: false)'),
  })
  .strict()

export const checkCalendarSchema = z
  .object({
    days_ahead: z.number().optional().default(7).describe('Number of days ahead to check (default: 7 days)'),
    calendar_id: z.string().optional().default('primary').describe('Calendar ID to check (default: primary calendar)'),
  })
  .strict()

export const searchDriveSchema = z
  .object({
    query: z.string().describe(
      `Google Drive search query using Google's native API syntax. Format: query_term operator 'value'

QUERY TERMS:
• name: File name (operators: contains, =, !=)
• fullText: Content and metadata search (operator: contains)  
• mimeType: File type (operators: =, !=)
• modifiedTime: Last modification date (operators: <, <=, =, !=, >, >=)
• viewedByMeTime: Last viewed date (operators: <, <=, =, !=, >, >=)
• createdTime: Creation date (operators: <, <=, =, !=, >, >=)
• trashed: In trash (operators: =, !=, values: true/false)
• starred: Starred status (operators: =, !=, values: true/false)
• sharedWithMe: Shared with user (operators: =, !=, values: true/false)
• parents: Parent folder ID (operator: in, format: 'folderId' in parents)
• owners: Owner email (operator: in, format: 'user@example.com' in owners)
• writers: Write permission (operator: in, format: 'user@example.com' in writers)
• readers: Read permission (operator: in, format: 'user@example.com' in readers)
• properties: Public properties (operator: has, format: properties has {key='dept' and value='sales'})
• appProperties: Private properties (operator: has)
• visibility: Visibility level (operators: =, !=)

OPERATORS: contains, =, !=, <, <=, >, >=, in, has, and, or, not

VALUE FORMATTING:
• Strings: Enclose in single quotes, escape quotes with \\'
• Booleans: true or false (no quotes)  
• Dates: RFC 3339 format '2025-01-01T00:00:00Z'
• Use parentheses for grouping: (condition1 or condition2) and condition3

EXAMPLES:
• name contains 'report'
• mimeType = 'application/pdf'  
• modifiedTime > '2025-01-01T00:00:00Z'
• name contains 'budget' and trashed = false
• (name contains 'report' or fullText contains 'summary') and modifiedTime > '2024-12-01T00:00:00Z'
• 'parentFolderId' in parents
• starred = true and mimeType = 'application/vnd.google-apps.document'`,
    ),
    max_results: z.number().optional().default(20).describe('Maximum number of files to return (default: 20, max: 50)'),
    include_trashed: z.boolean().optional().default(false).describe('Include files in trash folder'),
  })
  .strict()

export const getDriveFileContentSchema = z
  .object({
    file_id: z.string().describe('The Google Drive file ID to retrieve content from'),
  })
  .strict()

// =============================================================================
// TYPES
// =============================================================================

export type CheckInboxParams = z.infer<typeof checkInboxSchema>
export type SearchEmailsParams = z.infer<typeof searchEmailsSchema>
export type GetEmailParams = z.infer<typeof getEmailSchema>
export type DraftEmailParams = z.infer<typeof draftEmailSchema>
export type CheckCalendarParams = z.infer<typeof checkCalendarSchema>
export type SearchDriveParams = z.infer<typeof searchDriveSchema>
export type GetDriveFileContentParams = z.infer<typeof getDriveFileContentSchema>

export type EmailSummary = {
  id: string
  thread_id: string
  from: string
  subject: string
  snippet: string
  date: string
  is_unread: boolean
  has_attachments: boolean
  labels: string[]
}

export type ConversationSummary = {
  thread_id: string
  message_count: number
  from: string
  subject: string
  snippet: string
  latest_date: string
  is_unread: boolean
  has_attachments: boolean
  labels: string[]
}

export type EmailDetails = {
  id: string
  thread_id: string
  from: { name: string; email: string }
  to: Array<{ name: string; email: string }>
  cc?: Array<{ name: string; email: string }>
  subject: string
  date: string
  body_text: string
  body_html?: string
  attachments: Array<{
    id: string
    filename: string
    mime_type: string
    size_bytes: number
  }>
  labels: string[]
  is_unread: boolean
}

export type CalendarEvent = {
  id: string
  summary: string
  start: string
  end: string
  all_day: boolean
  location?: string
  description?: string
  attendees_count?: number
  meeting_link?: string
  status: 'confirmed' | 'tentative' | 'cancelled'
}

export type DriveFile = {
  id: string
  name: string
  mime_type: string
  size_bytes?: number
  created_time: string
  modified_time: string
  web_view_link: string
  web_content_link?: string
  is_folder: boolean
  shared: boolean
  owned_by_me: boolean
  parent_folders?: string[]
  description?: string
}

/**
 * Result of attempting to extract text content from a Google Drive file.
 * Uses structured metadata to let the LLM craft appropriate responses.
 */
export type DriveFileContent = {
  file_id: string
  file_name: string
  mime_type: string
  content: string | null
  /** When true, content was truncated to prevent context overflow */
  isTruncated?: boolean
  /** When true, text extraction was not possible */
  extraction_failed?: boolean
  /** Category of failure: 'unsupported_type' | 'access_denied' | 'not_found' */
  failure_reason?: 'unsupported_type' | 'access_denied' | 'not_found'
  /** Hint about the file type category for LLM context */
  file_category?: 'pdf' | 'image' | 'video' | 'audio' | 'binary' | 'unknown'
}

/** Categorize MIME type for LLM context when file type is unsupported */
const getDriveFileCategory = (mime: string): DriveFileContent['file_category'] => {
  if (mime === 'application/pdf') {
    return 'pdf'
  }
  if (mime.startsWith('image/')) {
    return 'image'
  }
  if (mime.startsWith('video/')) {
    return 'video'
  }
  if (mime.startsWith('audio/')) {
    return 'audio'
  }
  if (mime.includes('octet-stream') || mime.includes('binary')) {
    return 'binary'
  }
  return 'unknown'
}

// =============================================================================
// MAIN FUNCTIONS
// =============================================================================

/**
 * Check inbox for recent email threads (conversations) with lightweight summaries
 */
export const checkInbox = async (params: CheckInboxParams, httpClient: HttpClient = http) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  const searchParams = new URLSearchParams()
  searchParams.set('maxResults', Math.min(params.max_results, 50).toString())
  searchParams.set('labelIds', params.label)
  if (params.include_spam_trash) {
    searchParams.set('includeSpamTrash', 'true')
  }

  // Get list of thread IDs instead of individual messages
  const listResponse = await httpClient
    .get('https://www.googleapis.com/gmail/v1/users/me/threads', {
      searchParams,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<{ threads?: Array<{ id: string; snippet?: string; historyId?: string }>; resultSizeEstimate?: number }>()

  if (!listResponse.threads?.length) {
    return {
      conversations: [],
      total_count: 0,
      has_more: false,
    }
  }

  // Get thread details in parallel
  const threadDetails = await Promise.all(
    listResponse.threads.map(async (thread) => {
      const threadResponse = await httpClient
        .get(`https://www.googleapis.com/gmail/v1/users/me/threads/${thread.id}`, {
          searchParams: { format: 'metadata', metadataHeaders: 'From,To,Subject,Date' },
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .json<any>()

      // Get the most recent message in the thread for display info
      const latestMessage = threadResponse.messages?.[threadResponse.messages.length - 1]
      if (!latestMessage) {
        return null
      }

      // Check if thread has unread messages
      const hasUnread = threadResponse.messages?.some((msg: any) => msg.labelIds?.includes('UNREAD')) || false

      // Check if thread has attachments
      const hasAttachments =
        threadResponse.messages?.some((msg: any) =>
          msg.payload?.parts?.some((part: any) => part.filename && part.filename.length > 0),
        ) || false

      // Get labels from the latest message
      const labels = latestMessage.labelIds || []

      return {
        thread_id: thread.id,
        message_count: threadResponse.messages?.length || 1,
        from: getHeader(latestMessage, 'From'),
        subject: getHeader(latestMessage, 'Subject'),
        snippet: thread.snippet || '',
        latest_date: getHeader(latestMessage, 'Date'),
        is_unread: hasUnread,
        has_attachments: hasAttachments,
        labels,
      } as ConversationSummary
    }),
  )

  // Filter out any null results
  const validThreadDetails = threadDetails.filter(Boolean) as ConversationSummary[]

  return {
    conversations: validThreadDetails,
    total_count: listResponse.resultSizeEstimate || validThreadDetails.length,
    has_more: (listResponse.resultSizeEstimate || 0) > validThreadDetails.length,
  }
}

/**
 * Search emails using Gmail query syntax
 */
export const searchEmails = async (params: SearchEmailsParams, httpClient: HttpClient = http) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  const searchParams = new URLSearchParams()
  searchParams.set('maxResults', Math.min(params.max_results, 50).toString())
  searchParams.set('q', params.query)

  // Get list of message IDs
  const listResponse = await httpClient
    .get('https://www.googleapis.com/gmail/v1/users/me/messages', {
      searchParams,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }>()

  if (!listResponse.messages?.length) {
    return {
      messages: [],
      total_count: 0,
      has_more: false,
    }
  }

  // Get message details in parallel (metadata only for performance)
  const messageDetails = await Promise.all(
    listResponse.messages.map(async (msg) => {
      const detailResponse = await httpClient
        .get(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
          searchParams: { format: 'metadata', metadataHeaders: 'From,To,Subject,Date' },
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .json<any>()

      return {
        id: msg.id,
        thread_id: msg.threadId,
        from: getHeader(detailResponse, 'From'),
        subject: getHeader(detailResponse, 'Subject'),
        snippet: detailResponse.snippet || '',
        date: getHeader(detailResponse, 'Date'),
        is_unread: detailResponse.labelIds?.includes('UNREAD') || false,
        has_attachments:
          detailResponse.payload?.parts?.some((part: any) => part.filename && part.filename.length > 0) || false,
        labels: detailResponse.labelIds || [],
      } as EmailSummary
    }),
  )

  return {
    messages: messageDetails,
    total_count: listResponse.resultSizeEstimate || messageDetails.length,
    has_more: (listResponse.resultSizeEstimate || 0) > messageDetails.length,
  }
}

/**
 * Get full details of a specific email
 */
export const getEmail = async (params: GetEmailParams, httpClient: HttpClient = http) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  const response = await httpClient
    .get(`https://www.googleapis.com/gmail/v1/users/me/messages/${params.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<any>()

  // Extract email addresses
  const fromHeader = getHeader(response, 'From')
  const toHeader = getHeader(response, 'To')
  const ccHeader = getHeader(response, 'Cc')

  const from = parseEmailAddress(fromHeader)
  const to = toHeader
    .split(',')
    .map((addr) => parseEmailAddress(addr.trim()))
    .filter((addr) => addr.email)
  const cc = ccHeader
    ? ccHeader
        .split(',')
        .map((addr) => parseEmailAddress(addr.trim()))
        .filter((addr) => addr.email)
    : undefined

  // Extract body content
  const bodyText = extractBody(response.payload, 'text/plain')
  const bodyHtml = extractBody(response.payload, 'text/html')

  // Extract attachments
  const attachments: Array<{
    id: string
    filename: string
    mime_type: string
    size_bytes: number
  }> = []

  const extractAttachments = (parts: any[]) => {
    for (const part of parts || []) {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        attachments.push({
          id: part.body.attachmentId,
          filename: part.filename,
          mime_type: part.mimeType || 'application/octet-stream',
          size_bytes: part.body.size || 0,
        })
      }
      if (part.parts) {
        extractAttachments(part.parts)
      }
    }
  }

  if (response.payload?.parts) {
    extractAttachments(response.payload.parts)
  }

  return {
    id: params.id,
    thread_id: response.threadId || '',
    from,
    to,
    cc,
    subject: getHeader(response, 'Subject'),
    date: getHeader(response, 'Date'),
    body_text: truncateText(bodyText),
    body_html: bodyHtml ? truncateText(bodyHtml) : undefined,
    attachments,
    labels: response.labelIds || [],
    is_unread: response.labelIds?.includes('UNREAD') || false,
  } as EmailDetails
}

/**
 * Draft an email (ready to send later)
 */
export const draftEmail = async (params: DraftEmailParams, httpClient: HttpClient = http) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  const raw = buildRawMessage(params)

  const url = 'https://www.googleapis.com/gmail/v1/users/me/drafts'

  // If replying to an email, we need to set up threading
  const requestBody: any = {
    message: {
      raw,
    },
  }

  if (params.reply_to_id) {
    // Get the original message to extract thread ID
    const originalMessage = await httpClient
      .get(`https://www.googleapis.com/gmail/v1/users/me/messages/${params.reply_to_id}`, {
        searchParams: { format: 'metadata', metadataHeaders: 'Message-ID,References' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json<any>()

    if (originalMessage.threadId) {
      requestBody.message.threadId = originalMessage.threadId
    }
  }

  const response = await httpClient
    .post(url, {
      json: requestBody,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<any>()

  return {
    draft_id: response.id,
    thread_id: response.message?.threadId,
    created_at: new Date().toISOString(),
  }
}

/**
 * Check calendar events for upcoming days
 */
export const checkCalendar = async (params: CheckCalendarParams, httpClient: HttpClient = http) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  const now = new Date()
  const futureDate = new Date()
  futureDate.setDate(now.getDate() + params.days_ahead)

  const searchParams = new URLSearchParams()
  searchParams.set('calendarId', params.calendar_id)
  searchParams.set('timeMin', now.toISOString())
  searchParams.set('timeMax', futureDate.toISOString())
  searchParams.set('singleEvents', 'true')
  searchParams.set('orderBy', 'startTime')
  searchParams.set('maxResults', '50')

  try {
    const response = await httpClient
      .get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        searchParams,
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json<any>()

    const events: CalendarEvent[] = (response.items || []).map((event: any) => {
      const start = event.start?.dateTime || event.start?.date
      const end = event.end?.dateTime || event.end?.date
      const isAllDay = !event.start?.dateTime

      // Extract meeting link
      let meetingLink: string | undefined
      if (event.hangoutLink) {
        meetingLink = event.hangoutLink
      } else if (event.conferenceData?.entryPoints?.length) {
        meetingLink = event.conferenceData.entryPoints[0].uri
      }

      return {
        id: event.id,
        summary: event.summary || 'No title',
        start,
        end,
        all_day: isAllDay,
        location: event.location,
        description: event.description ? truncateText(event.description, 200) : undefined,
        attendees_count: event.attendees?.length || 0,
        meeting_link: meetingLink,
        status: event.status === 'confirmed' ? 'confirmed' : event.status === 'tentative' ? 'tentative' : 'cancelled',
      } as CalendarEvent
    })

    return {
      events,
      timezone: response.timeZone || 'UTC',
    }
  } catch (error: any) {
    // Calendar API might not be enabled or accessible
    if (error.response?.status === 403 || error.response?.status === 404) {
      return {
        events: [],
        timezone: 'UTC',
        error: 'Calendar access not available. Please enable Google Calendar API access.',
      }
    }
    throw error
  }
}

/**
 * Search Google Drive files using Drive API
 */
export const searchDrive = async (params: SearchDriveParams, httpClient: HttpClient = http) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  const searchParams = new URLSearchParams()
  searchParams.set('pageSize', Math.min(params.max_results, 50).toString())
  searchParams.set(
    'fields',
    'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,parents,description,shared,ownedByMe),nextPageToken',
  )
  // Enable access to files in Shared Drives (Team Drives)
  searchParams.set('supportsAllDrives', 'true')
  searchParams.set('includeItemsFromAllDrives', 'true')

  // Build the search query
  let searchQuery = transformDriveQuery(params.query)
  if (!params.include_trashed) {
    searchQuery = searchQuery ? `${searchQuery} and trashed=false` : 'trashed=false'
  }

  if (searchQuery) {
    searchParams.set('q', searchQuery)
  }

  try {
    const response = await httpClient
      .get('https://www.googleapis.com/drive/v3/files', {
        searchParams,
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json<any>()

    const files: DriveFile[] = (response.files || []).map((file: any) => ({
      id: file.id,
      name: file.name || 'Untitled',
      mime_type: file.mimeType || 'application/octet-stream',
      size_bytes: file.size ? parseInt(file.size, 10) : undefined,
      created_time: file.createdTime || '',
      modified_time: file.modifiedTime || '',
      web_view_link: file.webViewLink || '',
      web_content_link: file.webContentLink,
      is_folder: file.mimeType === 'application/vnd.google-apps.folder',
      shared: file.shared || false,
      owned_by_me: file.ownedByMe !== false, // Default to true if not specified
      parent_folders: file.parents || [],
      description: file.description ? truncateText(file.description, 200) : undefined,
    }))

    return {
      files,
      total_count: files.length,
      has_more: !!response.nextPageToken,
    }
  } catch (error: any) {
    // Drive API might not be enabled or accessible
    if (error.response?.status === 403) {
      return {
        files: [],
        total_count: 0,
        has_more: false,
        error: 'Google Drive access not available. Please enable Google Drive API access.',
      }
    }
    throw error
  }
}

/**
 * Extract file ID from a Google Drive/Docs/Sheets/Slides URL.
 * If the input is already a file ID (no URL pattern match), returns it as-is.
 */
export const extractDriveFileId = (input: string): string => {
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
  ]
  for (const pattern of patterns) {
    const match = input.match(pattern)
    if (match) {
      return match[1]
    }
  }
  return input
}

/**
 * Get text content from a Google Drive file
 * Works with Google Docs, Sheets, Slides, and text files
 */
export const getDriveFileContent = async (
  params: GetDriveFileContentParams,
  httpClient: HttpClient = http,
): Promise<DriveFileContent> => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidGoogleToken(httpClient, credentials)

  // Extract file ID from URL if a full URL was provided
  const fileId = extractDriveFileId(params.file_id)

  try {
    // Get file metadata to determine type (supportsAllDrives enables Shared Drive access)
    const fileResponse = await httpClient
      .get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        searchParams: { fields: 'id,name,mimeType', supportsAllDrives: 'true' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .json<any>()

    const fileName = fileResponse.name || 'Unknown'
    const mimeType = fileResponse.mimeType || 'application/octet-stream'

    let content = ''

    // Extract content based on file type
    if (mimeType === 'application/vnd.google-apps.document') {
      // Google Docs - export as plain text
      const response = await httpClient.get(`https://www.googleapis.com/drive/v3/files/${fileId}/export`, {
        searchParams: { mimeType: 'text/plain', supportsAllDrives: 'true' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      content = await response.text()
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Google Sheets - export as CSV
      const response = await httpClient.get(`https://www.googleapis.com/drive/v3/files/${fileId}/export`, {
        searchParams: { mimeType: 'text/csv', supportsAllDrives: 'true' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      content = await response.text()
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      // Google Slides - export as plain text
      const response = await httpClient.get(`https://www.googleapis.com/drive/v3/files/${fileId}/export`, {
        searchParams: { mimeType: 'text/plain', supportsAllDrives: 'true' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      content = await response.text()
    } else if (mimeType.startsWith('text/')) {
      // Text files - get raw content
      const response = await httpClient.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        searchParams: { alt: 'media', supportsAllDrives: 'true' },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      content = await response.text()
    } else {
      // Unsupported file type - return structured metadata for LLM to craft response
      return {
        file_id: fileId,
        file_name: fileName,
        mime_type: mimeType,
        content: null,
        extraction_failed: true,
        failure_reason: 'unsupported_type',
        file_category: getDriveFileCategory(mimeType),
      }
    }

    const isTruncated = content.length > llmContentCharLimit
    return {
      file_id: fileId,
      file_name: fileName,
      mime_type: mimeType,
      content: isTruncated ? content.substring(0, llmContentCharLimit) + '...[truncated]' : content,
      isTruncated,
    }
  } catch (error: unknown) {
    const httpError = error as { response?: { status: number } }
    if (httpError.response?.status === 403) {
      return {
        file_id: fileId,
        file_name: 'Unknown',
        mime_type: 'unknown',
        content: null,
        extraction_failed: true,
        failure_reason: 'access_denied',
      }
    }

    if (httpError.response?.status === 404) {
      return {
        file_id: fileId,
        file_name: 'Unknown',
        mime_type: 'unknown',
        content: null,
        extraction_failed: true,
        failure_reason: 'not_found',
      }
    }

    throw error
  }
}

// =============================================================================
// TOOL CONFIGURATIONS
// =============================================================================

/**
 * Google Tools Configuration Factory
 *
 * This file exports 7 high-level, LLM-friendly Google tools that replace
 * the previous 70+ low-level API tools. The new tools provide:
 *
 * 1. google_check_inbox - Check Gmail inbox/folders with lightweight conversation summaries
 * 2. google_search_emails - Search emails using Gmail query syntax
 * 3. google_get_email - Get full details of a specific email
 * 4. google_draft_email - Create email drafts (including replies)
 * 5. google_check_calendar - Check Google Calendar for upcoming events
 * 6. google_search_drive - Search Google Drive files using Drive API query syntax
 * 7. google_get_drive_file_content - Get content from Google Drive files (Docs, Sheets, Slides, etc.)
 *
 * Benefits:
 * - Reduced cognitive load for LLMs (7 vs 70+ tools)
 * - Smaller, more manageable response payloads
 * - Higher-level abstractions that accomplish common tasks in single calls
 * - Read-only operations (except drafting) for safer usage
 *
 * @param httpClient - HTTP client for making requests (injected for dependency injection)
 */
export const createConfigs = (httpClient: HttpClient): ToolConfig[] => [
  {
    name: 'google_check_inbox',
    description:
      'Check Gmail inbox or other folders for recent email conversations (threads) with lightweight summaries',
    verb: 'Checking Gmail inbox',
    parameters: checkInboxSchema,
    execute: (params: CheckInboxParams) => checkInbox(params, httpClient),
  },
  {
    name: 'google_search_emails',
    description: 'Search all Gmail messages using Gmail query syntax (e.g. "from:example.com subject:important")',
    verb: 'Searching Gmail messages',
    parameters: searchEmailsSchema,
    execute: (params: SearchEmailsParams) => searchEmails(params, httpClient),
  },
  {
    name: 'google_get_email',
    description: 'Get full details of a specific Gmail message including body content and attachments',
    verb: 'Getting Gmail message details',
    parameters: getEmailSchema,
    execute: (params: GetEmailParams) => getEmail(params, httpClient),
  },
  {
    name: 'google_draft_email',
    description: 'Create a draft email (can be a new email or reply to existing). Draft will be saved but not sent.',
    verb: 'Creating Gmail draft',
    parameters: draftEmailSchema,
    execute: (params: DraftEmailParams) => draftEmail(params, httpClient),
  },
  {
    name: 'google_check_calendar',
    description: 'Check Google Calendar for upcoming events in the specified timeframe',
    verb: 'Checking Google Calendar',
    parameters: checkCalendarSchema,
    execute: (params: CheckCalendarParams) => checkCalendar(params, httpClient),
  },
  {
    name: 'google_search_drive',
    description:
      'Search Google Drive files using Drive API query syntax (e.g. "type:pdf name:contract" or "modifiedTime>2024-01-01T00:00:00Z"). Use RFC 3339 format for dates.',
    verb: 'Searching Google Drive',
    parameters: searchDriveSchema,
    execute: (params: SearchDriveParams) => searchDrive(params, httpClient),
  },
  {
    name: 'google_get_drive_file_content',
    description:
      'Get text content from a Google Drive file. Accepts file IDs or full Google URLs (drive.google.com, docs.google.com/document, docs.google.com/spreadsheets, docs.google.com/presentation). Supports Google Docs, Sheets (as CSV), Slides, and text files. For unsupported types (PDFs, images, etc.), returns file metadata with extraction_failed=true.',
    verb: 'Getting Drive file content',
    parameters: getDriveFileContentSchema,
    execute: (params: GetDriveFileContentParams) => getDriveFileContent(params, httpClient),
  },
]

/**
 * Default configs using the default http client
 * @deprecated Use createConfigs() with an injected httpClient instead
 */
export const configs = createConfigs(http)
