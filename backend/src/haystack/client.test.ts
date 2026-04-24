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

const mockSearchResponse = {
  results: [
    {
      query_id: 'q1',
      query: 'test query',
      answers: [],
      documents: [
        {
          id: 'd1',
          content: 'Document content here',
          score: 0.95,
          file: { id: 'f1', name: 'report.pdf' },
          meta: { page_number: 1 },
        },
        {
          id: 'd2',
          content: 'More content',
          score: 0.7,
          file: { id: 'f2', name: 'notes.pdf' },
          meta: {},
        },
      ],
    },
  ],
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

/** Creates a mock fetch that returns different responses on sequential calls. */
const createSequentialMockFetch = (responses: Array<{ body: unknown; status: number }>) => {
  let callIndex = 0
  return mock(() => {
    const { body, status } = responses[Math.min(callIndex++, responses.length - 1)]
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 200 || status === 201 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
}

describe('HaystackClient', () => {
  let mockFetch: ReturnType<typeof createMockFetch>

  beforeEach(() => {
    mockFetch = createMockFetch({})
  })

  describe('createSession', () => {
    it('should call correct URL and return session ID', async () => {
      mockFetch = createMockFetch(mockCreateSessionResponse, 201)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      const result = await client.createSession()

      expect(result).toEqual({ searchSessionId: 'da81f24c-1586-4518-8360-70f40fcee960' })
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/search_sessions')
      expect(options.method).toBe('POST')
      expect(JSON.parse(options.body as string)).toEqual({
        pipeline_id: '15cf8b39-6583-490e-b88f-21af87bb6ce0',
      })
    })

    it('should set Authorization header with Bearer token', async () => {
      mockFetch = createMockFetch(mockCreateSessionResponse, 201)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await client.createSession()

      const [, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      const headers = options.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-api-key-123')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers.Accept).toBe('application/json')
    })

    it('should throw on non-OK response', async () => {
      mockFetch = createMockFetch({ errors: ['Unauthorized'] }, 401)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await expect(client.createSession()).rejects.toThrow('Haystack API error: 401')
    })

    it('should retry on 591 and succeed on second attempt', async () => {
      const seqFetch = createSequentialMockFetch([
        { body: {}, status: 591 },
        { body: mockCreateSessionResponse, status: 201 },
      ])
      const client = new HaystackClient(testConfig, seqFetch as unknown as typeof fetch, 0)

      const result = await client.createSession()

      expect(result).toEqual({ searchSessionId: 'da81f24c-1586-4518-8360-70f40fcee960' })
      expect(seqFetch).toHaveBeenCalledTimes(2)
    })

    it('should throw after exhausting 591 retries', async () => {
      const seqFetch = createSequentialMockFetch([
        { body: {}, status: 591 },
        { body: {}, status: 591 },
        { body: {}, status: 591 },
      ])
      const client = new HaystackClient(testConfig, seqFetch as unknown as typeof fetch, 0)

      await expect(client.createSession()).rejects.toThrow('Haystack API error: 591')
      expect(seqFetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('chatStream', () => {
    it('should call correct URL with SSE accept header', async () => {
      mockFetch = createMockFetch({})
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await client.chatStream({ query: 'test', sessionId: 'session-123' })

      const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(
        'https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/pipelines/test-pipeline/chat-stream',
      )
      expect(options.method).toBe('POST')
      const headers = options.headers as Record<string, string>
      expect(headers.Accept).toBe('text/event-stream')
    })

    it('should pass abort signal through', async () => {
      mockFetch = createMockFetch({})
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)
      const ac = new AbortController()

      await client.chatStream({ query: 'test', sessionId: 'session-123' }, ac.signal)

      const [, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(options.signal).toBe(ac.signal)
    })

    it('should throw on non-OK response', async () => {
      mockFetch = createMockFetch({}, 500)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await expect(client.chatStream({ query: 'test', sessionId: 's1' })).rejects.toThrow('Haystack API error: 500')
    })

    it('should retry on 591', async () => {
      const seqFetch = createSequentialMockFetch([
        { body: {}, status: 591 },
        { body: {}, status: 200 },
      ])
      const client = new HaystackClient(testConfig, seqFetch as unknown as typeof fetch, 0)

      const response = await client.chatStream({ query: 'test', sessionId: 's1' })

      expect(response.ok).toBe(true)
      expect(seqFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('search', () => {
    it('should call correct URL with query', async () => {
      mockFetch = createMockFetch(mockSearchResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await client.search('GDPR enforcement')

      const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/pipelines/test-pipeline/search')
      expect(options.method).toBe('POST')
      expect(JSON.parse(options.body as string)).toEqual({ queries: ['GDPR enforcement'] })
    })

    it('should return parsed documents from first result', async () => {
      mockFetch = createMockFetch(mockSearchResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      const result = await client.search('test query')

      expect(result.documents).toHaveLength(2)
      expect(result.documents[0].id).toBe('d1')
      expect(result.documents[0].file.name).toBe('report.pdf')
      expect(result.documents[1].score).toBe(0.7)
    })

    it('should return empty payload when no results', async () => {
      mockFetch = createMockFetch({ results: [] })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      const result = await client.search('nothing')

      expect(result).toEqual({ answers: [], documents: [] })
    })

    it('should pass abort signal', async () => {
      mockFetch = createMockFetch(mockSearchResponse)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)
      const ac = new AbortController()

      await client.search('test', ac.signal)

      const [, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(options.signal).toBe(ac.signal)
    })

    it('should retry on 591', async () => {
      const seqFetch = createSequentialMockFetch([
        { body: {}, status: 591 },
        { body: mockSearchResponse, status: 200 },
      ])
      const client = new HaystackClient(testConfig, seqFetch as unknown as typeof fetch, 0)

      const result = await client.search('test')

      expect(result.documents).toHaveLength(2)
      expect(seqFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('getOutputType', () => {
    it('should return CHAT for chat-type pipelines', async () => {
      mockFetch = createMockFetch({ output_type: 'CHAT', supports_prompt: true })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      const type = await client.getOutputType()

      expect(type).toBe('CHAT')
    })

    it('should return DOCUMENT for document-type pipelines', async () => {
      mockFetch = createMockFetch({ output_type: 'DOCUMENT', supports_prompt: false })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      const type = await client.getOutputType()

      expect(type).toBe('DOCUMENT')
    })

    it('should cache result after first call', async () => {
      mockFetch = createMockFetch({ output_type: 'DOCUMENT' })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await client.getOutputType()
      await client.getOutputType()
      await client.getOutputType()

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should default to CHAT when API returns unknown type', async () => {
      mockFetch = createMockFetch({ output_type: 'SOMETHING_ELSE' })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      expect(await client.getOutputType()).toBe('CHAT')
    })

    it('should default to CHAT when API returns no output_type', async () => {
      mockFetch = createMockFetch({ name: 'pipeline' })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      expect(await client.getOutputType()).toBe('CHAT')
    })

    it('should default to CHAT on API error', async () => {
      mockFetch = createMockFetch({}, 500)
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      expect(await client.getOutputType()).toBe('CHAT')
    })

    it('should default to CHAT on network failure', async () => {
      const failingFetch = mock(() => Promise.reject(new Error('Network error')))
      const client = new HaystackClient(testConfig, failingFetch as unknown as typeof fetch, 0)

      expect(await client.getOutputType()).toBe('CHAT')
    })

    it('should call correct pipeline metadata URL', async () => {
      mockFetch = createMockFetch({ output_type: 'CHAT' })
      const client = new HaystackClient(testConfig, mockFetch as unknown as typeof fetch, 0)

      await client.getOutputType()

      const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/pipelines/test-pipeline')
      expect(options.method).toBe('GET')
    })
  })

  describe('downloadFile', () => {
    it('should call correct URL and return the response', async () => {
      const mockResponse = new Response('pdf-binary-content', {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
      const fileFetch = mock(() => Promise.resolve(mockResponse))
      const client = new HaystackClient(testConfig, fileFetch as unknown as typeof fetch, 0)

      const result = await client.downloadFile('file-abc-123')

      expect(fileFetch).toHaveBeenCalledTimes(1)
      const [url] = fileFetch.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.cloud.deepset.ai/api/v1/workspaces/test_workspace/files/file-abc-123')
      expect(result).toBe(mockResponse)
    })

    it('should reject invalid file IDs', async () => {
      const client = new HaystackClient(
        testConfig,
        mock(() => Promise.resolve(new Response())) as unknown as typeof fetch,
        0,
      )

      await expect(client.downloadFile('../etc/passwd')).rejects.toThrow('Invalid file ID')
      await expect(client.downloadFile('file id with spaces')).rejects.toThrow('Invalid file ID')
    })

    it('should throw on non-OK response', async () => {
      const fileFetch = mock(() => Promise.resolve(new Response('Not found', { status: 404, statusText: 'Not Found' })))
      const client = new HaystackClient(testConfig, fileFetch as unknown as typeof fetch, 0)

      await expect(client.downloadFile('nonexistent')).rejects.toThrow('Haystack API error: 404 Not Found')
    })
  })
})
