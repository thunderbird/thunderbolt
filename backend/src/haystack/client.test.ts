import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { HaystackClient } from './client'
import type { HaystackConfig } from './types'

const testConfig: HaystackConfig = {
  apiKey: 'test-api-key-123',
  baseUrl: 'https://api.cloud.deepset.ai',
  workspaceName: 'test_workspace',
  pipelineName: 'test-pipeline',
  pipelineId: '15cf8b39-6583-490e-b88f-21af87bb6ce0',
}

const mockCreateSessionResponse = {
  search_session_id: 'da81f24c-1586-4518-8360-70f40fcee960',
}

const mockChatResponse = {
  query_id: '34b9ada9-e8b6-434e-8798-882342981e2d',
  results: [
    {
      query_id: '34b9ada9-e8b6-434e-8798-882342981e2d',
      query: 'What documents are in this workspace?',
      answers: [
        {
          answer: 'The workspace contains documents on cross-border data flows...',
          type: 'generative',
          document_ids: ['92cb6855527ffa6e3adf7f322c0f0f70'],
          files: [
            {
              id: 'a1581e4a-f586-4f28-b3a5-f47ff1349b1d',
              name: '07_EN_Cross_Border_Data_Flow_Framework.pdf',
            },
          ],
          meta: {
            _references: [
              {
                label: 'grounded',
                document_id: '92cb6855527ffa6e3adf7f322c0f0f70',
                document_position: 1,
                score: 0.0,
              },
            ],
          },
        },
      ],
      documents: [
        {
          id: '92cb6855527ffa6e3adf7f322c0f0f70',
          content: 'The framework addresses three core pillars...',
          score: 0.0024726231566347743,
          file: {
            id: 'a1581e4a-f586-4f28-b3a5-f47ff1349b1d',
            name: '07_EN_Cross_Border_Data_Flow_Framework.pdf',
          },
          meta: { file_name: '07_EN_Cross_Border_Data_Flow_Framework.pdf' },
        },
      ],
      extra_outputs: {},
    },
  ],
}

const mockListSessionsResponse = {
  search_sessions: [
    {
      search_session_id: 'da81f24c-1586-4518-8360-70f40fcee960',
      pipeline_id: '15cf8b39-6583-490e-b88f-21af87bb6ce0',
      search_history: {
        query: 'What documents are in this workspace?',
        created_at: '2026-03-12T19:55:46.931324+00:00',
      },
      title: null,
    },
    {
      search_session_id: '90d16ef8-371c-40b0-b112-15814827e576',
      pipeline_id: '15cf8b39-6583-490e-b88f-21af87bb6ce0',
      search_history: null,
      title: null,
    },
  ],
  has_more: false,
  total: 2,
}

const createMockFetch = (responseBody: unknown, status = 200) =>
  mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )

describe('HaystackClient', () => {
  let mockFetch: ReturnType<typeof createMockFetch>

  beforeEach(() => {
    mockFetch = createMockFetch({})
  })

  describe('createSession', () => {
    it('should call correct URL and return session ID', async () => {
      mockFetch = createMockFetch(mockCreateSessionResponse, 201)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      const result = await client.createSession()

      expect(result).toEqual({ searchSessionId: 'da81f24c-1586-4518-8360-70f40fcee960' })
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/search_sessions')
      expect(options.method).toBe('POST')
      expect(JSON.parse(options.body as string)).toEqual({
        pipeline_id: '15cf8b39-6583-490e-b88f-21af87bb6ce0',
      })
    })

    it('should set Authorization header with Bearer token', async () => {
      mockFetch = createMockFetch(mockCreateSessionResponse, 201)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await client.createSession()

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
      const headers = options.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-api-key-123')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers.Accept).toBe('application/json')
    })

    it('should throw on non-OK response', async () => {
      mockFetch = createMockFetch({ errors: ['Unauthorized'] }, 401)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await expect(client.createSession()).rejects.toThrow('Haystack API error: 401')
    })
  })

  describe('chat', () => {
    it('should send query and return transformed response', async () => {
      mockFetch = createMockFetch(mockChatResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      const result = await client.chat({
        query: 'What documents are in this workspace?',
        sessionId: 'da81f24c-1586-4518-8360-70f40fcee960',
      })

      expect(result.queryId).toBe('34b9ada9-e8b6-434e-8798-882342981e2d')
      expect(result.results).toHaveLength(1)
      expect(result.results[0].answers).toHaveLength(1)
      expect(result.results[0].answers[0].answer).toBe('The workspace contains documents on cross-border data flows...')
      expect(result.results[0].answers[0].type).toBe('generative')
      expect(result.results[0].answers[0].documentIds).toEqual(['92cb6855527ffa6e3adf7f322c0f0f70'])
      expect(result.results[0].answers[0].files).toEqual([
        { id: 'a1581e4a-f586-4f28-b3a5-f47ff1349b1d', name: '07_EN_Cross_Border_Data_Flow_Framework.pdf' },
      ])
      expect(result.results[0].answers[0].meta._references).toEqual([
        { label: 'grounded', documentId: '92cb6855527ffa6e3adf7f322c0f0f70', documentPosition: 1, score: 0.0 },
      ])
      expect(result.results[0].documents).toHaveLength(1)
      expect(result.results[0].documents[0].id).toBe('92cb6855527ffa6e3adf7f322c0f0f70')
      expect(result.results[0].documents[0].score).toBe(0.0024726231566347743)
      expect(result.results[0].documents[0].file.name).toBe('07_EN_Cross_Border_Data_Flow_Framework.pdf')
    })

    it('should call correct URL with workspace and pipeline name', async () => {
      mockFetch = createMockFetch(mockChatResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await client.chat({
        query: 'test query',
        sessionId: 'session-123',
      })

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/pipelines/test-pipeline/chat')
    })

    it('should send query as array with session ID and default chatHistoryLimit', async () => {
      mockFetch = createMockFetch(mockChatResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await client.chat({
        query: 'test query',
        sessionId: 'session-123',
      })

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(options.body as string)).toEqual({
        queries: ['test query'],
        search_session_id: 'session-123',
        chat_history_limit: 3,
      })
    })

    it('should include custom chatHistoryLimit when specified', async () => {
      mockFetch = createMockFetch(mockChatResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await client.chat({
        query: 'test query',
        sessionId: 'session-123',
        chatHistoryLimit: 10,
      })

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(options.body as string)).toEqual({
        queries: ['test query'],
        search_session_id: 'session-123',
        chat_history_limit: 10,
      })
    })

    it('should throw on API error', async () => {
      mockFetch = createMockFetch({ errors: ['Pipeline not found'] }, 404)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await expect(client.chat({ query: 'test', sessionId: 'session-123' })).rejects.toThrow('Haystack API error: 404')
    })

    it('should handle response with empty files and references', async () => {
      const responseWithEmptyArrays = {
        query_id: 'q1',
        results: [
          {
            query_id: 'q1',
            query: 'test',
            answers: [
              {
                answer: 'No relevant documents found.',
                type: 'generative',
                document_ids: [],
                files: [],
                meta: { _references: [] },
              },
            ],
            documents: [],
          },
        ],
      }
      mockFetch = createMockFetch(responseWithEmptyArrays)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      const result = await client.chat({ query: 'test', sessionId: 's1' })

      expect(result.results[0].answers[0].files).toEqual([])
      expect(result.results[0].answers[0].meta._references).toEqual([])
      expect(result.results[0].documents).toEqual([])
    })
  })

  describe('listSessions', () => {
    it('should return transformed paginated sessions', async () => {
      mockFetch = createMockFetch(mockListSessionsResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      const result = await client.listSessions()

      expect(result.total).toBe(2)
      expect(result.hasMore).toBe(false)
      expect(result.searchSessions).toHaveLength(2)
      expect(result.searchSessions[0]).toEqual({
        searchSessionId: 'da81f24c-1586-4518-8360-70f40fcee960',
        pipelineId: '15cf8b39-6583-490e-b88f-21af87bb6ce0',
        searchHistory: {
          query: 'What documents are in this workspace?',
          createdAt: '2026-03-12T19:55:46.931324+00:00',
        },
      })
    })

    it('should handle sessions with null search history', async () => {
      mockFetch = createMockFetch(mockListSessionsResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      const result = await client.listSessions()

      expect(result.searchSessions[1].searchHistory).toBeNull()
    })

    it('should call correct URL with GET method', async () => {
      mockFetch = createMockFetch(mockListSessionsResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await client.listSessions()

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/search_sessions')
      expect(options.method).toBe('GET')
    })

    it('should handle empty sessions list', async () => {
      mockFetch = createMockFetch({ search_sessions: [], has_more: false, total: 0 })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      const result = await client.listSessions()

      expect(result.searchSessions).toEqual([])
      expect(result.total).toBe(0)
    })

    it('should throw on API error', async () => {
      mockFetch = createMockFetch({ errors: ['Forbidden'] }, 403)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch)

      await expect(client.listSessions()).rejects.toThrow('Haystack API error: 403')
    })
  })

  describe('downloadFile', () => {
    it('should call correct URL and return the response', async () => {
      const mockResponse = new Response('pdf-binary-content', {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="test.pdf"',
        },
      })
      const fileFetch = mock(() => Promise.resolve(mockResponse))
      const client = new HaystackClient(testConfig, fileFetch as unknown as typeof fetch)

      const result = await client.downloadFile('file-abc-123')

      expect(fileFetch).toHaveBeenCalledTimes(1)
      const [url, options] = fileFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/files/file-abc-123')
      expect(options.method).toBe('GET')
      const headers = options.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-api-key-123')
      expect(result).toBe(mockResponse)
    })

    it('should throw on non-OK response', async () => {
      const fileFetch = mock(() => Promise.resolve(new Response('Not found', { status: 404, statusText: 'Not Found' })))
      const client = new HaystackClient(testConfig, fileFetch as unknown as typeof fetch)

      await expect(client.downloadFile('nonexistent')).rejects.toThrow('Haystack API error: 404 Not Found')
    })
  })
})
