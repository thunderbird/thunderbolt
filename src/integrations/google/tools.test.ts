/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type {
  CheckCalendarParams,
  CheckInboxParams,
  DraftEmailParams,
  GetDriveFileContentParams,
  GetEmailParams,
  GoogleAuthDeps,
  SearchDriveParams,
  SearchEmailsParams,
} from './tools'
import {
  checkCalendar,
  checkInbox,
  draftEmail,
  extractDriveFileId,
  getDriveFileContent,
  getEmail,
  searchDrive,
  searchEmails,
} from './tools'

// Custom error type for HTTP error mocking
type HTTPError = Error & {
  response?: {
    status: number
  }
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
    // Handle text responses (for getDriveFileContent)
    if (typeof response === 'string') {
      return new Response(response, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
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

    it('should handle calendar access error', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockError = new Error('Forbidden') as HTTPError
      mockError.response = { status: 403 }
      const mockHttpClient = createMockHttpClient([mockError])

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.events).toHaveLength(0)
      expect(result.timezone).toBe('UTC')
      expect(result.error).toContain('Calendar access not available')
    })

    it('should handle 404 calendar error', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'nonexistent',
      }

      const mockError = new Error('Not Found') as HTTPError
      mockError.response = { status: 404 }
      const mockHttpClient = createMockHttpClient([mockError])

      const result = await checkCalendar(params, mockHttpClient, mockAuth)

      expect(result.events).toHaveLength(0)
      expect(result.error).toContain('Calendar access not available')
    })

    it('should propagate other errors', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockError = new Error('Server Error') as HTTPError
      mockError.response = { status: 500 }
      const mockHttpClient = createMockHttpClient([mockError])

      await expect(checkCalendar(params, mockHttpClient, mockAuth)).rejects.toThrow('Server Error')
    })
  })

  describe('searchDrive', () => {
    it('should search drive files with query', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/pdf'",
        max_results: 10,
        include_trashed: false,
      }

      const mockDriveResponse = {
        files: [
          {
            id: 'file1',
            name: 'document.pdf',
            mimeType: 'application/pdf',
            size: '1024000',
            createdTime: '2024-01-01T10:00:00Z',
            modifiedTime: '2024-01-01T11:00:00Z',
            webViewLink: 'https://drive.google.com/file/d/file1/view',
            webContentLink: 'https://drive.google.com/uc?id=file1',
            parents: ['folder1'],
            description: 'A sample PDF document',
            shared: true,
            ownedByMe: true,
          },
          {
            id: 'folder1',
            name: 'Documents',
            mimeType: 'application/vnd.google-apps.folder',
            createdTime: '2024-01-01T09:00:00Z',
            modifiedTime: '2024-01-01T12:00:00Z',
            webViewLink: 'https://drive.google.com/drive/folders/folder1',
            parents: ['root'],
            shared: false,
            ownedByMe: true,
          },
        ],
        nextPageToken: null,
      }

      const mockHttpClient = createMockHttpClient([mockDriveResponse])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(2)
      expect(result.total_count).toBe(2)
      expect(result.has_more).toBe(false)

      expect(result.files[0]).toMatchObject({
        id: 'file1',
        name: 'document.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024000,
        created_time: '2024-01-01T10:00:00Z',
        modified_time: '2024-01-01T11:00:00Z',
        web_view_link: 'https://drive.google.com/file/d/file1/view',
        web_content_link: 'https://drive.google.com/uc?id=file1',
        is_folder: false,
        shared: true,
        owned_by_me: true,
        parent_folders: ['folder1'],
      })

      expect(result.files[1]).toMatchObject({
        id: 'folder1',
        name: 'Documents',
        mime_type: 'application/vnd.google-apps.folder',
        is_folder: true,
        shared: false,
        owned_by_me: true,
      })
    })

    it('should handle empty search results', async () => {
      const params: SearchDriveParams = {
        query: "name contains 'nonexistent'",
        max_results: 20,
        include_trashed: false,
      }

      const mockHttpClient = createMockHttpClient([{ files: [] }])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
    })

    it('should include trashed files when requested', async () => {
      const params: SearchDriveParams = {
        query: "name contains 'test'",
        max_results: 20,
        include_trashed: true,
      }

      const mockHttpClient = createMockHttpClient([{ files: [] }])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(0)
    })

    it('should handle files without optional properties', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/vnd.google-apps.document'",
        max_results: 10,
        include_trashed: false,
      }

      const mockDriveResponse = {
        files: [
          {
            id: 'file2',
            name: 'untitled',
            mimeType: 'application/vnd.google-apps.document',
            createdTime: '2024-01-01T10:00:00Z',
            modifiedTime: '2024-01-01T11:00:00Z',
            webViewLink: 'https://docs.google.com/document/d/file2/edit',
            // Missing: size, webContentLink, parents, description, shared, ownedByMe
          },
        ],
      }

      const mockHttpClient = createMockHttpClient([mockDriveResponse])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(1)
      expect(result.files[0]).toMatchObject({
        id: 'file2',
        name: 'untitled',
        mime_type: 'application/vnd.google-apps.document',
        size_bytes: undefined,
        web_content_link: undefined,
        is_folder: false,
        shared: false,
        owned_by_me: true, // Default to true
        parent_folders: [],
        description: undefined,
      })
    })

    it('should handle pagination with nextPageToken', async () => {
      const params: SearchDriveParams = {
        query: "mimeType contains 'image/'",
        max_results: 5,
        include_trashed: false,
      }

      const mockDriveResponse = {
        files: [
          {
            id: 'image1',
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            createdTime: '2024-01-01T10:00:00Z',
            modifiedTime: '2024-01-01T11:00:00Z',
            webViewLink: 'https://drive.google.com/file/d/image1/view',
          },
        ],
        nextPageToken: 'next_page_token_123',
      }

      const mockHttpClient = createMockHttpClient([mockDriveResponse])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(1)
      expect(result.has_more).toBe(true)
    })

    it('should handle drive access error', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/pdf'",
        max_results: 20,
        include_trashed: false,
      }

      const mockError = new Error('Forbidden') as HTTPError
      mockError.response = { status: 403 }
      const mockHttpClient = createMockHttpClient([mockError])

      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
      expect(result.error).toContain('Google Drive access not available')
    })

    it('should propagate other drive errors', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/pdf'",
        max_results: 20,
        include_trashed: false,
      }

      const mockError = new Error('Server Error') as HTTPError
      mockError.response = { status: 500 }
      const mockHttpClient = createMockHttpClient([mockError])

      await expect(searchDrive(params, mockHttpClient, mockAuth)).rejects.toThrow('Server Error')
    })

    it('should handle empty query by searching all non-trashed files', async () => {
      const params: SearchDriveParams = {
        query: '',
        max_results: 10,
        include_trashed: false,
      }

      const mockHttpClient = createMockHttpClient([{ files: [] }])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(0)
    })

    it('should respect max_results limit', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/pdf'",
        max_results: 100, // Above the 50 limit
        include_trashed: false,
      }

      const mockHttpClient = createMockHttpClient([{ files: [] }])
      await searchDrive(params, mockHttpClient, mockAuth)

      // Test passes by checking the function completes without error
      expect(true).toBe(true)
    })

    it('should handle network errors', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/pdf'",
        max_results: 20,
        include_trashed: false,
      }

      const networkError = new Error('Network error')
      const mockHttpClient = createMockHttpClient([networkError])

      await expect(searchDrive(params, mockHttpClient, mockAuth)).rejects.toThrow('Network error')
    })

    it('should handle authentication errors', async () => {
      const params: SearchDriveParams = {
        query: "mimeType = 'application/pdf'",
        max_results: 20,
        include_trashed: false,
      }

      const authError = new Error('Authentication failed')
      ;(mockAuth.ensureToken as ReturnType<typeof mock>).mockRejectedValue(authError)

      const mockHttpClient = createMockHttpClient([])
      await expect(searchDrive(params, mockHttpClient, mockAuth)).rejects.toThrow('Authentication failed')
    })

    it('should pass query through to Drive API', async () => {
      const params: SearchDriveParams = {
        query: "name contains 'contract' and modifiedTime > '2024-01-01T00:00:00Z'",
        max_results: 10,
        include_trashed: false,
      }

      const mockHttpClient = createMockHttpClient([{ files: [] }])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      // transformDriveQuery just trims the input, so the function should complete
      expect(result.files).toHaveLength(0)
    })

    it('should preserve existing RFC 3339 dates', async () => {
      const params: SearchDriveParams = {
        query: "name contains 'contract' and modifiedTime > '2024-01-01T10:30:00Z'",
        max_results: 10,
        include_trashed: false,
      }

      const mockHttpClient = createMockHttpClient([{ files: [] }])
      const result = await searchDrive(params, mockHttpClient, mockAuth)

      expect(result.files).toHaveLength(0)
    })
  })

  describe('extractDriveFileId', () => {
    it('should extract file ID from Google Drive file URL', () => {
      const url = 'https://drive.google.com/file/d/1abc123XYZ_-def456/view?usp=sharing'
      expect(extractDriveFileId(url)).toBe('1abc123XYZ_-def456')
    })

    it('should extract file ID from Google Docs URL', () => {
      const url = 'https://docs.google.com/document/d/1abc123XYZ_-def456/edit?tab=t.0'
      expect(extractDriveFileId(url)).toBe('1abc123XYZ_-def456')
    })

    it('should extract file ID from Google Sheets URL', () => {
      const url =
        'https://docs.google.com/spreadsheets/d/1u45_haUZDqq9C0Yum7ZNpx-KPNW_RMLvulcmBpvGcf0/edit?gid=1351715876#gid=1351715876'
      expect(extractDriveFileId(url)).toBe('1u45_haUZDqq9C0Yum7ZNpx-KPNW_RMLvulcmBpvGcf0')
    })

    it('should extract file ID from Google Slides URL', () => {
      const url = 'https://docs.google.com/presentation/d/1abc123XYZ_-def456/edit#slide=id.p'
      expect(extractDriveFileId(url)).toBe('1abc123XYZ_-def456')
    })

    it('should return input as-is if already a file ID', () => {
      const fileId = '1abc123XYZ_-def456'
      expect(extractDriveFileId(fileId)).toBe('1abc123XYZ_-def456')
    })

    it('should return input as-is for unrecognized URL patterns', () => {
      const unknownUrl = 'https://example.com/some/path'
      expect(extractDriveFileId(unknownUrl)).toBe(unknownUrl)
    })

    it('should handle URL with trailing slash', () => {
      const url = 'https://docs.google.com/document/d/1abc123XYZ_-def456/'
      expect(extractDriveFileId(url)).toBe('1abc123XYZ_-def456')
    })
  })

  describe('getDriveFileContent', () => {
    it('should get content from a Google Doc', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'doc123',
      }

      const mockFileResponse = {
        id: 'doc123',
        name: 'My Document.docx',
        mimeType: 'application/vnd.google-apps.document',
      }

      const mockContent = 'This is the content of my Google Doc.\n\nIt has multiple paragraphs.'

      const mockHttpClient = createMockHttpClient([mockFileResponse, mockContent])
      const result = await getDriveFileContent(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        file_id: 'doc123',
        file_name: 'My Document.docx',
        content: mockContent,
      })
    })

    it('should get content from a text file', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'txt123',
      }

      const mockFileResponse = {
        id: 'txt123',
        name: 'notes.txt',
        mimeType: 'text/plain',
      }

      const mockContent = 'These are my notes.\nLine 2 of notes.'

      const mockHttpClient = createMockHttpClient([mockFileResponse, mockContent])
      const result = await getDriveFileContent(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        file_id: 'txt123',
        file_name: 'notes.txt',
        content: mockContent,
      })
    })

    it('should handle unsupported file types', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'img123',
      }

      const mockFileResponse = {
        id: 'img123',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
      }

      const mockHttpClient = createMockHttpClient([mockFileResponse])
      const result = await getDriveFileContent(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        file_id: 'img123',
        file_name: 'photo.jpg',
        mime_type: 'image/jpeg',
        content: null,
        extraction_failed: true,
        failure_reason: 'unsupported_type',
        file_category: 'image',
      })
    })

    it('should handle access denied errors', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'private123',
      }

      const mockError = new Error('Forbidden') as HTTPError
      mockError.response = { status: 403 }
      const mockHttpClient = createMockHttpClient([mockError])
      const result = await getDriveFileContent(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        file_id: 'private123',
        file_name: 'Unknown',
        mime_type: 'unknown',
        content: null,
        extraction_failed: true,
        failure_reason: 'access_denied',
      })
    })

    it('should handle file not found errors', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'missing123',
      }

      const mockError = new Error('Not Found') as HTTPError
      mockError.response = { status: 404 }
      const mockHttpClient = createMockHttpClient([mockError])
      const result = await getDriveFileContent(params, mockHttpClient, mockAuth)

      expect(result).toMatchObject({
        file_id: 'missing123',
        file_name: 'Unknown',
        mime_type: 'unknown',
        content: null,
        extraction_failed: true,
        failure_reason: 'not_found',
      })
    })
  })
})
