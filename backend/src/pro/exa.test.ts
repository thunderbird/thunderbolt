import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia, t } from 'elysia'

// Create a test version of the plugin with mocked Exa client
const createTestExaPlugin = (mockExaClient: any) => {
  return new Elysia({ name: 'exa-test' })
    .onError(({ code, error, set }) => {
      set.status = code === 'VALIDATION' ? 400 : 500
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      }
    })
    .state('exaClient', mockExaClient)
    .post(
      '/search',
      async ({ body, store }): Promise<any> => {
        if (!store.exaClient) {
          throw new Error('Search service is not configured.')
        }

        const response = await store.exaClient.search(body.query, {
          numResults: body.max_results,
          useAutoprompt: true,
          type: 'fast',
        })

        return {
          data: response.results,
          success: true,
        }
      },
      {
        body: t.Object({
          query: t.String(),
          max_results: t.Optional(t.Number({ default: 10 })),
        }),
      },
    )
    .post(
      '/fetch-content',
      async ({ body, store }): Promise<any> => {
        if (!store.exaClient) {
          throw new Error('Fetch content service is not configured.')
        }

        const maxCharacters = 16000

        const response = await store.exaClient.getContents([body.url], {
          livecrawlTimeout: 5000,
          extras: { imageLinks: 1 },
          text: { maxCharacters },
          summary: { query: 'Main content and key information' },
        })

        const result = response.results[0]
        if (!result) {
          return { data: null, success: true }
        }

        return {
          data: {
            ...result,
            wasTruncated: (result.text?.length ?? 0) >= maxCharacters,
          },
          success: true,
        }
      },
      {
        body: t.Object({
          url: t.String(),
        }),
      },
    )
}

describe('Pro - Exa Plugin', () => {
  let app: any
  let mockSearch: any
  let mockGetContents: any

  beforeEach(() => {
    // Create fresh mocks
    mockSearch = mock(() => Promise.resolve({ results: [] }))
    mockGetContents = mock(() => Promise.resolve({ results: [] }))

    const mockExaClient = {
      search: mockSearch,
      getContents: mockGetContents,
    }

    // Create app with mocked client
    app = new Elysia().use(createTestExaPlugin(mockExaClient))
  })

  describe('POST /search', () => {
    it('should perform search successfully with API key configured', async () => {
      const mockResults = [
        {
          title: 'Test Result',
          url: 'https://example.com',
          publishedDate: '2024-01-01',
          author: 'Test Author',
        },
      ]
      mockSearch.mockResolvedValueOnce({ results: mockResults })

      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test search' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        data: mockResults,
        success: true,
      })
      expect(mockSearch).toHaveBeenCalledWith('test search', {
        numResults: 10,
        useAutoprompt: true,
        type: 'fast',
      })
    })

    it('should respect max_results parameter', async () => {
      mockSearch.mockResolvedValueOnce({ results: [] })

      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test search', max_results: 5 }),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockSearch).toHaveBeenCalledWith('test search', {
        numResults: 5,
        useAutoprompt: true,
        type: 'fast',
      })
    })

    it('should use default max_results when not provided', async () => {
      mockSearch.mockResolvedValueOnce({ results: [] })

      await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test search' }),
        }),
      )

      expect(mockSearch).toHaveBeenCalledWith('test search', {
        numResults: 10,
        useAutoprompt: true,
        type: 'fast',
      })
    })

    it('should throw error when API key is not configured', async () => {
      // Create app with null client to simulate no API key
      const appNoKey = new Elysia().use(createTestExaPlugin(null))

      const response = await appNoKey.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test search' }),
        }),
      )

      expect(response.status).toBe(500)
      const data = await response.json()
      expect(data).toHaveProperty('success', false)
      expect(data).toHaveProperty('data', null)
      expect(data).toHaveProperty('error')
      expect(data.error).toContain('Search service is not configured')
    })

    it('should return 400 when query is missing', async () => {
      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toHaveProperty('success', false)
      expect(data).toHaveProperty('error')
    })

    it('should return 400 when body is invalid', async () => {
      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 123 }), // query should be string
        }),
      )

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toHaveProperty('success', false)
      expect(data).toHaveProperty('error')
    })

    it('should handle search API errors gracefully', async () => {
      mockSearch.mockRejectedValueOnce(new Error('API rate limit exceeded'))

      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test search' }),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should handle empty search results', async () => {
      mockSearch.mockResolvedValueOnce({ results: [] })

      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'obscure search query' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        data: [],
        success: true,
      })
    })

    it('should handle multiple search results', async () => {
      const mockResults = [
        { title: 'Result 1', url: 'https://example1.com' },
        { title: 'Result 2', url: 'https://example2.com' },
        { title: 'Result 3', url: 'https://example3.com' },
      ]
      mockSearch.mockResolvedValueOnce({ results: mockResults })

      const response = await app.handle(
        new Request('http://localhost/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test search' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data).toHaveLength(3)
    })
  })

  describe('POST /fetch-content', () => {
    it('should fetch content successfully with API key configured', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'This is the fetched content',
          summary: 'A summary of the content',
          author: 'Test Author',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        data: {
          ...mockContent[0],
          wasTruncated: false,
        },
        success: true,
      })
      expect(mockGetContents).toHaveBeenCalledWith(['https://example.com'], {
        livecrawlTimeout: 5000,
        extras: { imageLinks: 1 },
        text: { maxCharacters: 16000 },
        summary: { query: 'Main content and key information' },
      })
    })

    it('should throw error when API key is not configured', async () => {
      // Create app with null client to simulate no API key
      const appNoKey = new Elysia().use(createTestExaPlugin(null))

      const response = await appNoKey.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(500)
      const text = await response.text()
      expect(text).toContain('Fetch content service is not configured')
    })

    it('should return 400 when url is missing', async () => {
      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toHaveProperty('success', false)
      expect(data).toHaveProperty('error')
    })

    it('should return 400 when url is not a string', async () => {
      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 123 }), // should be string
        }),
      )

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toHaveProperty('success', false)
      expect(data).toHaveProperty('error')
    })

    it('should handle fetch API errors gracefully', async () => {
      mockGetContents.mockRejectedValueOnce(new Error('Network error'))

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should handle empty content results', async () => {
      mockGetContents.mockResolvedValueOnce({ results: [] })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({
        data: null,
        success: true,
      })
    })

    it('should handle different URL formats', async () => {
      const testCases = [
        'https://example.com',
        'http://example.com',
        'https://subdomain.example.com/path?query=1',
        'https://example.com/page#anchor',
      ]

      for (const url of testCases) {
        mockGetContents.mockResolvedValueOnce({ results: [{ url, text: 'content' }] })

        const response = await app.handle(
          new Request('http://localhost/fetch-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          }),
        )

        expect(response.status).toBe(200)
        expect(mockGetContents).toHaveBeenCalledWith([url], {
          livecrawlTimeout: 5000,
          extras: { imageLinks: 1 },
          text: { maxCharacters: 16000 },
          summary: { query: 'Main content and key information' },
        })
      }
    })

    it('should set wasTruncated to true when text reaches max characters limit', async () => {
      // Create text that is exactly at the limit (16,000 chars)
      const longText = 'A'.repeat(16000)
      const mockContent = [
        {
          url: 'https://example.com/long',
          title: 'Long Page',
          text: longText,
          summary: 'Summary of long content',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/long' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.wasTruncated).toBe(true)
      expect(data.data.summary).toBe('Summary of long content')
    })

    it('should set wasTruncated to false when text is under the limit', async () => {
      const shortText = 'Short content'
      const mockContent = [
        {
          url: 'https://example.com/short',
          title: 'Short Page',
          text: shortText,
          summary: 'Summary of short content',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/short' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.wasTruncated).toBe(false)
    })

    it('should handle content with no text field', async () => {
      const mockContent = [
        {
          url: 'https://example.com/no-text',
          title: 'Page Without Text',
          summary: 'Summary only',
        },
      ]
      mockGetContents.mockResolvedValueOnce({ results: mockContent })

      const response = await app.handle(
        new Request('http://localhost/fetch-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/no-text' }),
        }),
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.data.wasTruncated).toBe(false)
    })
  })
})
