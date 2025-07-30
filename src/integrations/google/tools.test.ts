import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type {
  CheckCalendarParams,
  CheckInboxParams,
  DraftEmailParams,
  GetEmailParams,
  SearchEmailsParams,
  SearchDriveParams,
  GetDriveFileContentParams,
} from './tools'
import { checkCalendar, checkInbox, draftEmail, getEmail, searchEmails, searchDrive, getDriveFileContent } from './tools'

// Custom error type for HTTP error mocking
interface HTTPError extends Error {
  response?: {
    status: number
  }
}

// Mock external dependencies
const mockGet = mock()
const mockPost = mock()
const mockJson = mock()
const mockGetGoogleCredentials = mock()
const mockEnsureValidGoogleToken = mock()
const mockGetHeader = mock()
const mockParseEmailAddress = mock()
const mockExtractBody = mock()
const mockTruncateText = mock()
const mockBuildRawMessage = mock()

// Mock ky
mock.module('ky', () => ({
  default: {
    get: mockGet,
    post: mockPost,
  },
}))

// Mock utils
mock.module('./utils', () => ({
  getGoogleCredentials: mockGetGoogleCredentials,
  ensureValidGoogleToken: mockEnsureValidGoogleToken,
  getHeader: mockGetHeader,
  parseEmailAddress: mockParseEmailAddress,
  extractBody: mockExtractBody,
  truncateText: mockTruncateText,
  buildRawMessage: mockBuildRawMessage,
}))

describe('Google Tools', () => {
  beforeEach(() => {
    // Reset all mocks
    mockGet.mockClear()
    mockPost.mockClear()
    mockJson.mockClear()
    mockGetGoogleCredentials.mockClear()
    mockEnsureValidGoogleToken.mockClear()
    mockGetHeader.mockClear()
    mockParseEmailAddress.mockClear()
    mockExtractBody.mockClear()
    mockTruncateText.mockClear()
    mockBuildRawMessage.mockClear()

    // Setup default mocks
    mockGetGoogleCredentials.mockResolvedValue({
      access_token: 'test-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 3600000,
    })
    mockEnsureValidGoogleToken.mockResolvedValue('test-access-token')
    mockGet.mockReturnValue({ json: mockJson })
    mockPost.mockReturnValue({ json: mockJson })
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

      mockJson.mockResolvedValueOnce(mockThreadsResponse).mockResolvedValue(mockThreadDetails)

      mockGetHeader
        .mockReturnValueOnce('sender@example.com')
        .mockReturnValueOnce('Test Subject')
        .mockReturnValueOnce('2024-01-01T10:00:00Z')

      const result = await checkInbox(params)

      expect(result.conversations).toHaveLength(2)
      expect(result.total_count).toBe(25)
      expect(result.has_more).toBe(true)
      expect(result.conversations[0]).toMatchObject({
        thread_id: 'thread1',
        message_count: 1,
        snippet: 'First thread',
        is_unread: true,
        has_attachments: true,
      })

      expect(mockGet).toHaveBeenCalledWith(
        'https://www.googleapis.com/gmail/v1/users/me/threads',
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      )
    })

    it('should handle empty inbox', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: false,
      }

      mockJson.mockResolvedValue({ threads: [] })

      const result = await checkInbox(params)

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

      mockJson.mockResolvedValue({ threads: [] })

      await checkInbox(params)

      expect(mockGet).toHaveBeenCalledWith(
        'https://www.googleapis.com/gmail/v1/users/me/threads',
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        }),
      )

      // Verify includeSpamTrash parameter was set
      const call = mockGet.mock.calls[0]
      const searchParams = call[1].searchParams
      expect(searchParams.get('includeSpamTrash')).toBe('true')
    })

    it('should handle network errors', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: false,
      }

      const networkError = new Error('Network error')
      mockGet.mockImplementation(() => {
        throw networkError
      })

      await expect(checkInbox(params)).rejects.toThrow('Network error')
    })

    it('should handle authentication errors', async () => {
      const params: CheckInboxParams = {
        label: 'INBOX',
        max_results: 20,
        include_spam_trash: false,
      }

      const authError = new Error('Authentication failed')
      mockEnsureValidGoogleToken.mockRejectedValue(authError)

      await expect(checkInbox(params)).rejects.toThrow('Authentication failed')
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

      mockJson.mockResolvedValueOnce(mockMessagesResponse).mockResolvedValue(mockMessageDetails)

      mockGetHeader
        .mockReturnValueOnce('sender@example.com')
        .mockReturnValueOnce('Search Result')
        .mockReturnValueOnce('2024-01-01T10:00:00Z')

      const result = await searchEmails(params)

      expect(result.messages).toHaveLength(2)
      expect(result.total_count).toBe(50)
      expect(result.has_more).toBe(true)
      expect(result.messages[0]).toMatchObject({
        id: 'msg1',
        thread_id: 'thread1',
        snippet: 'Email content preview',
        is_unread: false,
        has_attachments: false,
      })

      expect(mockGet).toHaveBeenCalledWith(
        'https://www.googleapis.com/gmail/v1/users/me/messages',
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      )
    })

    it('should handle no search results', async () => {
      const params: SearchEmailsParams = {
        query: 'nonexistent query',
        max_results: 20,
      }

      mockJson.mockResolvedValue({ messages: [] })

      const result = await searchEmails(params)

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
              filename: 'document.pdf',
              body: { attachmentId: 'att123', size: 1024 },
              mimeType: 'application/pdf',
            },
          ],
        },
      }

      mockJson.mockResolvedValue(mockEmailResponse)

      mockGetHeader
        .mockReturnValueOnce('John Doe <john@example.com>') // From
        .mockReturnValueOnce('recipient@example.com') // To
        .mockReturnValueOnce('cc@example.com') // Cc
        .mockReturnValueOnce('Test Email') // Subject
        .mockReturnValueOnce('2024-01-01T10:00:00Z') // Date

      mockParseEmailAddress
        .mockReturnValueOnce({ name: 'John Doe', email: 'john@example.com' })
        .mockReturnValueOnce({ name: '', email: 'recipient@example.com' })
        .mockReturnValueOnce({ name: '', email: 'cc@example.com' })

      mockExtractBody.mockReturnValueOnce('Plain text body').mockReturnValueOnce('<p>HTML body</p>')

      mockTruncateText.mockReturnValueOnce('Plain text body').mockReturnValueOnce('<p>HTML body</p>')

      const result = await getEmail(params)

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

      expect(mockGet).toHaveBeenCalledWith(
        'https://www.googleapis.com/gmail/v1/users/me/messages/test-message-id',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      )
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
          // No parts = no attachments
        },
      }

      mockJson.mockResolvedValue(mockEmailResponse)
      mockGetHeader
        .mockReturnValueOnce('sender@example.com') // From
        .mockReturnValueOnce('recipient@example.com') // To
        .mockReturnValueOnce('') // Cc (empty)
        .mockReturnValueOnce('Simple Email') // Subject
        .mockReturnValueOnce('2024-01-01T10:00:00Z') // Date

      mockParseEmailAddress
        .mockReturnValueOnce({ name: '', email: 'sender@example.com' })
        .mockReturnValueOnce({ name: '', email: 'recipient@example.com' })

      mockExtractBody.mockReturnValueOnce('Simple email body').mockReturnValueOnce('')

      mockTruncateText.mockReturnValueOnce('Simple email body')

      const result = await getEmail(params)

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
      mockGet.mockImplementation(() => {
        throw networkError
      })

      await expect(getEmail(params)).rejects.toThrow('Failed to fetch email')
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

      mockJson.mockResolvedValue(mockDraftResponse)
      mockBuildRawMessage.mockReturnValue('base64-encoded-message')

      const result = await draftEmail(params)

      expect(result).toMatchObject({
        draft_id: 'draft-123',
        thread_id: 'thread-456',
        created_at: expect.any(String),
      })

      expect(mockPost).toHaveBeenCalledWith(
        'https://www.googleapis.com/gmail/v1/users/me/drafts',
        expect.objectContaining({
          json: {
            message: {
              raw: 'base64-encoded-message',
            },
          },
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      )

      expect(mockBuildRawMessage).toHaveBeenCalledWith(params)
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

      // Reset mockGet to create fresh mocks for this test
      mockGet.mockClear()
      mockGet.mockReturnValue({ json: mockJson })

      mockJson.mockResolvedValueOnce(mockOriginalMessage).mockResolvedValueOnce(mockDraftResponse)

      mockBuildRawMessage.mockReturnValue('base64-encoded-reply')

      const result = await draftEmail(params)

      expect(result.thread_id).toBe('existing-thread-123')

      // Should fetch original message first
      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('messages/original-msg-id'), expect.any(Object))

      // Should include thread ID in draft creation
      expect(mockPost).toHaveBeenCalledWith(
        'https://www.googleapis.com/gmail/v1/users/me/drafts',
        expect.objectContaining({
          json: {
            message: {
              raw: 'base64-encoded-reply',
              threadId: 'existing-thread-123',
            },
          },
        }),
      )
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

      mockJson.mockResolvedValue(mockCalendarResponse)
      mockTruncateText.mockReturnValue('Weekly team sync')

      const result = await checkCalendar(params)

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

      expect(mockGet).toHaveBeenCalledWith(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      )
    })

    it('should handle calendar access error', async () => {
      const params: CheckCalendarParams = {
        days_ahead: 7,
        calendar_id: 'primary',
      }

      const mockError = new Error('Forbidden') as HTTPError
      mockError.response = { status: 403 }
      mockGet.mockImplementation(() => {
        throw mockError
      })

      const result = await checkCalendar(params)

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
      mockGet.mockImplementation(() => {
        throw mockError
      })

      const result = await checkCalendar(params)

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
      mockGet.mockImplementation(() => {
        throw mockError
      })

      await expect(checkCalendar(params)).rejects.toThrow('Server Error')
    })
  })

  describe('searchDrive', () => {
    it('should search drive files with query', async () => {
      const params: SearchDriveParams = {
        query: 'type:pdf',
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

      mockJson.mockResolvedValue(mockDriveResponse)
      mockTruncateText.mockReturnValue('A sample PDF document')

      const result = await searchDrive(params)

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
        description: 'A sample PDF document',
      })

      expect(result.files[1]).toMatchObject({
        id: 'folder1',
        name: 'Documents',
        mime_type: 'application/vnd.google-apps.folder',
        is_folder: true,
        shared: false,
        owned_by_me: true,
      })

      expect(mockGet).toHaveBeenCalledWith(
        'https://www.googleapis.com/drive/v3/files',
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
          headers: { Authorization: 'Bearer test-access-token' },
        }),
      )

      // Verify the search query includes trashed=false
      const call = mockGet.mock.calls[0]
      const searchParams = call[1].searchParams
      expect(searchParams.get('q')).toBe('type:pdf and trashed=false')
    })

    it('should handle empty search results', async () => {
      const params: SearchDriveParams = {
        query: 'name:nonexistent',
        max_results: 20,
        include_trashed: false,
      }

      mockJson.mockResolvedValue({ files: [] })

      const result = await searchDrive(params)

      expect(result.files).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
    })

    it('should include trashed files when requested', async () => {
      const params: SearchDriveParams = {
        query: 'name:test',
        max_results: 20,
        include_trashed: true,
      }

      mockJson.mockResolvedValue({ files: [] })

      await searchDrive(params)

      // Verify that trashed=false is NOT added to the query
      const call = mockGet.mock.calls[0]
      const searchParams = call[1].searchParams
      expect(searchParams.get('q')).toBe('name:test')
    })

    it('should handle files without optional properties', async () => {
      const params: SearchDriveParams = {
        query: 'type:document',
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

      mockJson.mockResolvedValue(mockDriveResponse)

      const result = await searchDrive(params)

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
        query: 'type:image',
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

      mockJson.mockResolvedValue(mockDriveResponse)

      const result = await searchDrive(params)

      expect(result.files).toHaveLength(1)
      expect(result.has_more).toBe(true)
    })

    it('should handle drive access error', async () => {
      const params: SearchDriveParams = {
        query: 'type:pdf',
        max_results: 20,
        include_trashed: false,
      }

      const mockError = new Error('Forbidden') as HTTPError
      mockError.response = { status: 403 }
      mockGet.mockImplementation(() => {
        throw mockError
      })

      const result = await searchDrive(params)

      expect(result.files).toHaveLength(0)
      expect(result.total_count).toBe(0)
      expect(result.has_more).toBe(false)
      expect(result.error).toContain('Google Drive access not available')
    })

    it('should propagate other drive errors', async () => {
      const params: SearchDriveParams = {
        query: 'type:pdf',
        max_results: 20,
        include_trashed: false,
      }

      const mockError = new Error('Server Error') as HTTPError
      mockError.response = { status: 500 }
      mockGet.mockImplementation(() => {
        throw mockError
      })

      await expect(searchDrive(params)).rejects.toThrow('Server Error')
    })

    it('should handle empty query by searching all non-trashed files', async () => {
      const params: SearchDriveParams = {
        query: '',
        max_results: 10,
        include_trashed: false,
      }

      mockJson.mockResolvedValue({ files: [] })

      await searchDrive(params)

      const call = mockGet.mock.calls[0]
      const searchParams = call[1].searchParams
      expect(searchParams.get('q')).toBe('trashed=false')
    })

    it('should respect max_results limit', async () => {
      const params: SearchDriveParams = {
        query: 'type:pdf',
        max_results: 100, // Above the 50 limit
        include_trashed: false,
      }

      mockJson.mockResolvedValue({ files: [] })

      await searchDrive(params)

      const call = mockGet.mock.calls[0]
      const searchParams = call[1].searchParams
      expect(searchParams.get('pageSize')).toBe('50') // Should be clamped to 50
    })

    it('should handle network errors', async () => {
      const params: SearchDriveParams = {
        query: 'type:pdf',
        max_results: 20,
        include_trashed: false,
      }

      const networkError = new Error('Network error')
      mockGet.mockImplementation(() => {
        throw networkError
      })

      await expect(searchDrive(params)).rejects.toThrow('Network error')
    })

    it('should handle authentication errors', async () => {
      const params: SearchDriveParams = {
        query: 'type:pdf',
        max_results: 20,
        include_trashed: false,
      }

      const authError = new Error('Authentication failed')
      mockEnsureValidGoogleToken.mockRejectedValue(authError)

      await expect(searchDrive(params)).rejects.toThrow('Authentication failed')
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
      const mockTextFn = mock().mockResolvedValue(mockContent)

      mockJson.mockResolvedValueOnce(mockFileResponse)
      mockGet.mockReturnValueOnce({ json: mockJson }).mockReturnValueOnce({ text: mockTextFn })

      const result = await getDriveFileContent(params)

      expect(result).toMatchObject({
        file_id: 'doc123',
        file_name: 'My Document.docx',
        content: mockContent,
        truncated: false,
      })

      expect(mockGet).toHaveBeenCalledTimes(2)
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
      const mockTextFn = mock().mockResolvedValue(mockContent)

      mockJson.mockResolvedValueOnce(mockFileResponse)
      mockGet.mockReturnValueOnce({ json: mockJson }).mockReturnValueOnce({ text: mockTextFn })

      const result = await getDriveFileContent(params)

      expect(result).toMatchObject({
        file_id: 'txt123',
        file_name: 'notes.txt',
        content: mockContent,
        truncated: false,
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

      mockJson.mockResolvedValueOnce(mockFileResponse)

      const result = await getDriveFileContent(params)

      expect(result).toMatchObject({
        file_id: 'img123',
        file_name: 'photo.jpg',
        content: '',
        truncated: false,
        error: 'Cannot extract text from image/jpeg. Only Google Docs and text files are supported.',
      })
    })

    it('should handle access denied errors', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'private123',
      }

      const mockError = new Error('Forbidden') as HTTPError
      mockError.response = { status: 403 }
      mockGet.mockImplementation(() => {
        throw mockError
      })

      const result = await getDriveFileContent(params)

      expect(result).toMatchObject({
        file_id: 'private123',
        file_name: 'Unknown',
        content: '',
        truncated: false,
        error: 'Access denied. Make sure you have permission to read this file.',
      })
    })

    it('should handle file not found errors', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'missing123',
      }

      const mockError = new Error('Not Found') as HTTPError
      mockError.response = { status: 404 }
      mockGet.mockImplementation(() => {
        throw mockError
      })

      const result = await getDriveFileContent(params)

      expect(result).toMatchObject({
        file_id: 'missing123',
        file_name: 'Unknown',
        content: '',
        truncated: false,
        error: 'File not found.',
      })
    })

    it('should truncate long content', async () => {
      const params: GetDriveFileContentParams = {
        file_id: 'long123',
      }

      const mockFileResponse = {
        id: 'long123',
        name: 'long-document.docx',
        mimeType: 'application/vnd.google-apps.document',
      }

      // Create a string longer than the 50000 character limit
      const longContent = 'A'.repeat(60000)
      const mockTextFn = mock().mockResolvedValue(longContent)

      mockJson.mockResolvedValueOnce(mockFileResponse)
      mockGet.mockReturnValueOnce({ json: mockJson }).mockReturnValueOnce({ text: mockTextFn })
      mockTruncateText.mockReturnValue('A'.repeat(50000) + '...[truncated]')

      const result = await getDriveFileContent(params)

      expect(result.truncated).toBe(true)
      expect(mockTruncateText).toHaveBeenCalledWith(longContent, 50000)
    })
  })
})
