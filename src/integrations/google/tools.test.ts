/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type {
  CheckCalendarParams,
  CheckInboxParams,
  DraftEmailParams,
  GetEmailParams,
  GoogleAuthDeps,
  SearchEmailsParams,
} from './tools'
import { checkCalendar, checkInbox, draftEmail, getEmail, searchEmails } from './tools'

/**
 * Mock client that fails with a real non-ok `Response`, so the client under test
 * throws the same `HttpError` (body included) it would in the browser.
 */
const createErrorHttpClient = (status: number, body: unknown = {}): HttpClient =>
  createClient({
    fetch: async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  })

/** Mock client that records the requested URLs and returns `response` for each call. */
const createRecordingHttpClient = (response: unknown): { client: HttpClient; urls: string[] } => {
  const urls: string[] = []
  const client = createClient({
    fetch: async (input) => {
      urls.push(input instanceof Request ? input.url : input.toString())
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  return { client, urls }
}

/** Encode a string as Gmail-style base64url body data */
const toBase64Url = (str: string): string => {
  const bytes = new TextEncoder().encode(str)
  const base64 = btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ''))
  return base64.replace(/\+/g, '-').replace(/\//g, '_')
}

const createMockHttpClient = (responses: unknown[] = []): HttpClient => {
  let callCount = 0
  const mockFetch = async (): Promise<Response> => {
    const response = responses[callCount++] || responses[responses.length - 1]
    if (response instanceof Error) {
      throw response
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return createClient({ fetch: mockFetch })
}

// Dependency-injected auth mock (replaces mock.module for the 2 impure functions)
const mockAuth: GoogleAuthDeps = {
  getCredentials: mock(() =>
    Promise.resolve({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expires_at: Date.now() + 3600000,
    }),
  ),
  ensureToken: mock(() => Promise.resolve('mock-access-token')),
}

describe('Google Tools', () => {
  beforeEach(() => {
    ;(mockAuth.getCredentials as ReturnType<typeof mock>).mockClear()
    ;(mockAuth.ensureToken as ReturnType<typeof mock>).mockClear()
    ;(mockAuth.getCredentials as ReturnType<typeof mock>).mockResolvedValue({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expires_at: Date.now() + 3600000,
    })
    ;(mockAuth.ensureToken as ReturnType<typeof mock>).mockResolvedValue('mock-access-token')
  })

  describe('checkInbox', () => {
    it('should return conversations for inbox', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 10,
        include_spam_trash: false,
      }

      const mockThreadsResponse = {
        threads: [
          { id: 'thread1', snippet: 'First thread' },
          { id: 'thread2', snippet: 'Second thread' },
        ],
        resultSizeEstimate: 25,
      }

      const mockThreadDetails = {
        messages: [
          {
            id: 'msg1',
            labelIds: ['INBOX', 'UNREAD'],
            payload: {
              headers: [
                { name: 'From', value: 'sender@example.com' },
                { name: 'Subject', value: 'Test Subject' },
                { name: 'Date', value: '2024-01-01T10:00:00Z' },
              ],
              parts: [{ filename: 'attachment.pdf' }],
            },
          },
        ],
      }

      const mockHttpClient = createMockHttpClient([mockThreadsResponse, mockThreadDetails, mockThreadDetails])

      const result = await checkInbox(params, mockHttpClient, mockAuth)

      expect(result.conversations).toHaveLength(2)
      expect(result.total_count).toBe(25)
      expect(result.has_more).toBe(true)
      expect(result.conversations[0]).toMatchObject({
        thread_id: 'thread1',
        message_count: 1,
        from: 'sender@example.com',
        subject: 'Test Subject',
        snippet: 'First thread',
        is_unread: true,
        has_attachments: true,
      })
    })

    it('should handle empty inbox', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: false,
      }

      const mockHttpClient = createMockHttpClient([{ threads: [] }])

      const result = await checkInbox(params, mockHttpClient, mockAuth)

      expect(result.conversations).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
    })

    it('should include spam and trash when requested', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: true,
      }

      const mockHttpClient = createMockHttpClient([{ threads: [] }])

      const result = await checkInbox(params, mockHttpClient, mockAuth)

      expect(result.conversations).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
    })

    it('should handle network errors', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: false,
      }

      const networkError = new Error('Network error')
      const mockHttpClient = createMockHttpClient([networkError])

      await expect(checkInbox(params, mockHttpClient, mockAuth)).rejects.toThrow('Network error')
    })

    it('should handle authentication errors', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: false,
      }

      const authError = new Error('Authentication failed')
      ;(mockAuth.ensureToken as ReturnType<typeof mock>).mockRejectedValue(authError)

      const mockHttpClient = createMockHttpClient([])
      await expect(checkInbox(params, mockHttpClient, mockAuth)).rejects.toThrow('Authentication failed')
    })
  })

  describe('searchEmails', () => {
    it('should search emails with query', async () => {
      const params: SearchEmailsParams = {
        query: 'from:example.com',
        max_results: 15,
      }

      const mockMessagesResponse = {
        messages: [
          { id: 'msg1', threadId: 'thread1' },
          { id: 'msg2', threadId: 'thread2' },
        ],
        resultSizeEstimate: 50,
      }

      const mockMessageDetails = {
        snippet: 'Email content preview',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Subject', value: 'Search Result' },
            { name: 'Date', value: '2024-01-01T10:00:00Z' },
          ],
        },
      }

      const mockHttpClient = createMockHttpClient([mockMessagesResponse, mockMessageDetails, mockMessageDetails])

      const result = await searchEmails(params, mockHttpClient, mockAuth)

      expect(result.messages).toHaveLength(2)
      expect(result.total_count).toBe(50)
      expect(result.has_more).toBe(true)
      expect(result.messages[0]).toMatchObject({
        id: 'msg1',
        thread_id: 'thread1',
        from: 'sender@example.com',
        subject: 'Search Result',
        snippet: 'Email content preview',
        is_unread: false,
        has_attachments: false,
      })
    })

    it('should handle no search results', async () => {
      const params: SearchEmailsParams = {
        query: 'nonexistent query',
        max_results: 20,
      }

      const mockHttpClient = createMockHttpClient([{ messages: [] }])

      const result = await searchEmails(params, mockHttpClient, mockAuth)

      expect(result.messages).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
    })
  })

  describe('getEmail', () => {
    it('should get full email details', async () => {
      const params: GetEmailParams = {
        id: 'test-message-id',
      }

      const mockEmailResponse = {
        threadId: 'thread-123',
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          headers: [
            { name: 'From', value: 'John Doe <john@example.com>' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Cc', value: 'cc@example.com' },
            { name: 'Subject', value: 'Test Email' },
            { name: 'Date', value: '2024-01-01T10:00:00Z' },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: toBase64Url('Plain text body'), size: 15 },
            },
            {
              mimeType: 'text/html',
              body: { data: toBase64Url('<p>HTML body</p>'), size: 16 },
            },
            {
              filename: 'document.pdf',
              body: { attachmentId: 'att123', size: 1024 },
              mimeType: 'application/pdf',
            },
          ],
        },
      }

      const mockHttpClient = createMockHttpClient([mockEmailResponse])

      const result = await getEmail(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        id: 'test-message-id',
        thread_id: 'thread-123',
        from: { name: 'John Doe', email: 'john@example.com' },
        to: [{ name: '', email: 'recipient@example.com' }],
        cc: [{ name: '', email: 'cc@example.com' }],
        subject: 'Test Email',
        date: '2024-01-01T10:00:00Z',
        body_text: 'Plain text body',
        body_html: '<p>HTML body</p>',
        is_unread: true,
      })

      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]).toMatchObject({
        id: 'att123',
        filename: 'document.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
      })
    })

    it('should handle email without CC and attachments', async () => {
      const params: GetEmailParams = {
        id: 'simple-message-id',
      }

      const mockEmailResponse = {
        threadId: 'thread-456',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Subject', value: 'Simple Email' },
            { name: 'Date', value: '2024-01-01T10:00:00Z' },
          ],
          mimeType: 'text/plain',
          body: { data: toBase64Url('Simple email body'), size: 17 },
          // No parts = no attachments
        },
      }

      const mockHttpClient = createMockHttpClient([mockEmailResponse])

      const result = await getEmail(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        id: 'simple-message-id',
        thread_id: 'thread-456',
        from: { name: '', email: 'sender@example.com' },
        to: [{ name: '', email: 'recipient@example.com' }],
        cc: undefined, // No CC header
        subject: 'Simple Email',
        date: '2024-01-01T10:00:00Z',
        body_text: 'Simple email body',
        body_html: undefined, // No HTML body
        is_unread: false, // No UNREAD label
      })

      expect(result.attachments).toHaveLength(0)
    })

    it('should handle network errors in getEmail', async () => {
      const params: GetEmailParams = {
        id: 'test-message-id',
      }

      const networkError = new Error('Failed to fetch email')
      const mockHttpClient = createMockHttpClient([networkError])

      await expect(getEmail(params, mockHttpClient, mockAuth)).rejects.toThrow('Failed to fetch email')
    })
  })

  describe('draftEmail', () => {
    it('should create a basic email draft', async () => {
      const params: DraftEmailParams = {
        to: 'recipient@example.com',
        subject: 'Test Draft',
        body: 'Draft content',
      }

      const mockDraftResponse = {
        id: 'draft-123',
        message: {
          threadId: 'thread-456',
        },
      }

      const mockHttpClient = createMockHttpClient([mockDraftResponse])

      const result = await draftEmail(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        draft_id: 'draft-123',
        thread_id: 'thread-456',
        created_at: expect.any(String),
      })
    })

    it('should create reply draft with thread ID', async () => {
      const params: DraftEmailParams = {
        to: 'recipient@example.com',
        subject: 'Re: Original Subject',
        body: 'Reply content',
        reply_to_id: 'original-msg-id',
      }

      const mockOriginalMessage = {
        threadId: 'existing-thread-123',
      }

      const mockDraftResponse = {
        id: 'reply-draft-456',
        message: {
          threadId: 'existing-thread-123',
        },
      }

      const mockHttpClient = createMockHttpClient([mockOriginalMessage, mockDraftResponse])

      const result = await draftEmail(params, mockHttpClient, mockAuth)

      expect(result.thread_id).toBe('existing-thread-123')
    })
  })

  describe('checkCalendar', () => {
    it('should return calendar events', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockCalendarResponse = {
        items: [
          {
            id: 'event1',
            summary: 'Team Meeting',
            start: { dateTime: '2024-01-01T14:00:00Z' },
            end: { dateTime: '2024-01-01T15:00:00Z' },
            location: 'Conference Room A',
            description: 'Weekly team sync',
            attendees: [{ email: 'user1@example.com' }, { email: 'user2@example.com' }],
            hangoutLink: 'https://meet.google.com/abc-def-ghi',
            status: 'confirmed',
          },
          {
            id: 'event2',
            summary: 'All Day Event',
            start: { date: '2024-01-02' },
            end: { date: '2024-01-03' },
            status: 'tentative',
          },
        ],
        timeZone: 'America/New_York',
      }

      const mockHttpClient = createMockHttpClient([mockCalendarResponse])
      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.events).toHaveLength(2)
      expect(result.timezone).toBe('America/New_York')

      expect(result.events[0]).toMatchObject({
        id: 'event1',
        summary: 'Team Meeting',
        start: '2024-01-01T14:00:00Z',
        end: '2024-01-01T15:00:00Z',
        all_day: false,
        location: 'Conference Room A',
        description: 'Weekly team sync',
        attendees_count: 2,
        meeting_link: 'https://meet.google.com/abc-def-ghi',
        status: 'confirmed',
      })

      expect(result.events[1]).toMatchObject({
        id: 'event2',
        summary: 'All Day Event',
        all_day: true,
        status: 'tentative',
      })
    })

    it('should request the calendar named by calendar_id', async () => {
      const params: CheckCalendarParams = { days_ahead: 7, calendar_id: 'team@example.com' }

      const { client, urls } = createRecordingHttpClient({ items: [], timeZone: 'UTC' })
      await checkCalendar(params, client, mockAuth)

      const url = new URL(urls[0])
      expect(url.origin + url.pathname).toBe(
        'https://www.googleapis.com/calendar/v3/calendars/team%40example.com/events',
      )
      expect(urls[0]).not.toContain('calendarId=')
    })

    it('should apply both schema defaults when called with raw arguments', async () => {
      // The ACP/Pi bridge calls execute with the model's raw arguments, so the
      // zod defaults never run — `{}` is a shape this function really receives.
      const { client, urls } = createRecordingHttpClient({ items: [], timeZone: 'UTC' })
      await checkCalendar({} as CheckCalendarParams, client, mockAuth)

      expect(urls[0]).toContain('/calendars/primary/events')
      // A missing days_ahead used to reach toISOString() as NaN and throw.
      const timeMax = new URL(urls[0]).searchParams.get('timeMax')
      expect(Number.isNaN(Date.parse(timeMax ?? ''))).toBe(false)
    })

    it('should report a disabled Calendar API', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockHttpClient = createErrorHttpClient(403, {
        error: {
          code: 403,
          message: 'Google Calendar API has not been used in project 123 before or it is disabled.',
          errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }],
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      })

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.events).toHaveLength(0)
      expect(result.timezone).toBe('UTC')
      expect(result.error).toContain('not enabled for this Google Cloud project')
    })

    it('should report a token missing the calendar scope', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockHttpClient = createErrorHttpClient(403, {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          errors: [{ reason: 'insufficientPermissions', domain: 'global' }],
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      })

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.error).toContain('has not granted calendar access')
    })

    it('should fall back to the message from Google for an unrecognized 403', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockHttpClient = createErrorHttpClient(403, {
        error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
      })

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.error).toBe('Rate Limit Exceeded')
    })

    it('should degrade gracefully when the 403 body is not JSON', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockHttpClient = createClient({ fetch: async () => new Response('<html>denied</html>', { status: 403 }) })

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.events).toHaveLength(0)
      expect(result.error).toContain('Calendar access not available')
    })

    it('should name the missing calendar on a 404', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'nonexistent',
      }

      const mockHttpClient = createErrorHttpClient(404, {
        error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] },
      })

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.events).toHaveLength(0)
      expect(result.error).toContain('"nonexistent" was not found')
    })

    it('should propagate other errors', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockHttpClient = createErrorHttpClient(500, { error: { code: 500, message: 'Backend Error' } })

      await expect(checkCalendar(params, mockHttpClient, mockAuth)).rejects.toThrow('Request failed with status 500')
    })
  })
})
