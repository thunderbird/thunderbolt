import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { SimpleContext } from './context'
import { createExaClient, fetchContentExa, searchExa } from './exa'

// Mock the Exa SDK
const mockExa = {
  searchAndContents: spyOn({} as any, 'searchAndContents').mockResolvedValue({ results: [] }),
  getContents: spyOn({} as any, 'getContents').mockResolvedValue({ results: [] }),
}

// Mock the Exa constructor
const ExaModule = await import('exa-js')
spyOn(ExaModule as any, 'Exa').mockImplementation(() => mockExa as any)

// Mock getSettings
const mockGetSettings = spyOn(await import('../config/settings'), 'getSettings')

describe('Pro - Exa', () => {
  let mockContext: SimpleContext

  beforeEach(() => {
    mockContext = {
      info: spyOn({} as any, 'info').mockResolvedValue(undefined),
      error: spyOn({} as any, 'error').mockResolvedValue(undefined),
    } as any

    // Reset all mocks
    mockExa.searchAndContents.mockReset()
    mockExa.getContents.mockReset()
    mockGetSettings.mockReset()
  })

  describe('createExaClient', () => {
    it('should create Exa client when API key is configured', () => {
      mockGetSettings.mockReturnValue({
        exaApiKey: 'test-exa-key',
      } as any)

      const client = createExaClient()

      expect(client).not.toBeNull()
      expect(mockGetSettings).toHaveBeenCalled()
    })

    it('should return null when API key is not configured', () => {
      mockGetSettings.mockReturnValue({
        exaApiKey: '',
      } as any)

      const client = createExaClient()

      expect(client).toBeNull()
    })

    it('should return null when API key is undefined', () => {
      mockGetSettings.mockReturnValue({
        exaApiKey: undefined,
      } as any)

      const client = createExaClient()

      expect(client).toBeNull()
    })
  })

  describe('searchExa', () => {
    beforeEach(() => {
      mockGetSettings.mockReturnValue({
        exaApiKey: 'test-exa-key',
      } as any)
    })

    it('should perform search with default parameters', async () => {
      const mockResults = [
        {
          title: 'Test Result',
          url: 'https://example.com',
          text: 'Test content',
          author: 'Test Author',
          publishedDate: '2024-01-01',
          favicon: 'https://example.com/favicon.ico',
          image: 'https://example.com/image.png',
        },
      ]
      mockExa.searchAndContents.mockResolvedValueOnce({ results: mockResults })

      const results = await searchExa('test query', mockContext)

      expect(mockExa.searchAndContents).toHaveBeenCalledWith('test query', {
        numResults: 10,
        useAutoprompt: true,
        type: 'neural',
      })
      expect(results).toEqual([
        {
          position: 1,
          title: 'Test Result',
          url: 'https://example.com',
          snippet: 'Test content',
          author: 'Test Author',
          published_date: '2024-01-01',
          favicon: 'https://example.com/favicon.ico',
          image: 'https://example.com/image.png',
        },
      ])
    })

    it('should respect maxResults parameter', async () => {
      mockExa.searchAndContents.mockResolvedValueOnce({ results: [] })

      await searchExa('test query', mockContext, 5)

      expect(mockExa.searchAndContents).toHaveBeenCalledWith('test query', {
        numResults: 5,
        useAutoprompt: true,
        type: 'neural',
      })
    })

    it('should handle results without optional fields', async () => {
      const mockResults = [
        {
          title: 'Test Result',
          url: 'https://example.com',
          text: 'Test content',
          // author, publishedDate, favicon, and image are missing
        },
      ]
      mockExa.searchAndContents.mockResolvedValueOnce({ results: mockResults })

      const results = await searchExa('test query', mockContext)

      expect(results).toEqual([
        {
          position: 1,
          title: 'Test Result',
          url: 'https://example.com',
          snippet: 'Test content',
          author: null,
          published_date: null,
          favicon: null,
          image: null,
        },
      ])
    })

    it('should handle results without text content', async () => {
      const mockResults = [
        {
          title: 'Test Result',
          url: 'https://example.com',
          // text is missing
          author: 'Test Author',
          publishedDate: '2024-01-01',
        },
      ]
      mockExa.searchAndContents.mockResolvedValueOnce({ results: mockResults })

      const results = await searchExa('test query', mockContext)

      expect(results[0].snippet).toBe('')
    })

    it('should handle multiple results with correct positioning', async () => {
      const mockResults = [
        { title: 'Result 1', url: 'https://example1.com', text: 'Content 1' },
        { title: 'Result 2', url: 'https://example2.com', text: 'Content 2' },
        { title: 'Result 3', url: 'https://example3.com', text: 'Content 3' },
      ]
      mockExa.searchAndContents.mockResolvedValueOnce({ results: mockResults })

      const results = await searchExa('test query', mockContext)

      expect(results).toHaveLength(3)
      expect(results[0].position).toBe(1)
      expect(results[1].position).toBe(2)
      expect(results[2].position).toBe(3)
    })

    it('should return empty array when API key is not configured', async () => {
      mockGetSettings.mockReturnValue({
        exaApiKey: '',
      } as any)

      const results = await searchExa('test query', mockContext)

      expect(results).toEqual([])
      expect(mockExa.searchAndContents).not.toHaveBeenCalled()
    })

    it('should handle search errors', async () => {
      const error = new Error('API error')
      mockExa.searchAndContents.mockRejectedValueOnce(error)

      await expect(searchExa('test query', mockContext)).rejects.toThrow('API error')
    })

    it('should handle non-Error exceptions', async () => {
      mockExa.searchAndContents.mockRejectedValueOnce('String error')

      await expect(searchExa('test query', mockContext)).rejects.toBe('String error')
    })
  })

  describe('fetchContentExa', () => {
    beforeEach(() => {
      mockGetSettings.mockReturnValue({
        exaApiKey: 'test-exa-key',
      } as any)
    })

    it('should fetch content successfully', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: 'Test Page',
          text: 'This is the fetched content from the webpage',
          favicon: 'https://example.com/favicon.ico',
          image: 'https://example.com/image.png',
          author: 'Test Author',
          publishedDate: '2024-01-01',
        },
      ]
      mockExa.getContents.mockResolvedValueOnce({ results: mockContent })

      const result = await fetchContentExa('https://example.com', mockContext)

      expect(mockExa.getContents).toHaveBeenCalledWith(['https://example.com'], {
        text: {
          maxCharacters: 8000,
          includeHtmlTags: false,
        },
      })
      
      const parsed = JSON.parse(result)
      expect(parsed).toEqual({
        url: 'https://example.com',
        title: 'Test Page',
        text: 'This is the fetched content from the webpage',
        favicon: 'https://example.com/favicon.ico',
        image: 'https://example.com/image.png',
        author: 'Test Author',
        published_date: '2024-01-01',
      })
    })

    it('should handle empty content', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          title: null,
          text: '',
        },
      ]
      mockExa.getContents.mockResolvedValueOnce({ results: mockContent })

      const result = await fetchContentExa('https://example.com', mockContext)

      const parsed = JSON.parse(result)
      expect(parsed.text).toBe('')
      expect(parsed.url).toBe('https://example.com')
    })

    it('should handle no results', async () => {
      mockExa.getContents.mockResolvedValueOnce({ results: [] })

      const result = await fetchContentExa('https://example.com', mockContext)

      expect(result).toBe('Error: No content found for the provided URL')
    })

    it('should handle missing text field', async () => {
      const mockContent = [
        {
          url: 'https://example.com',
          // text field is missing
        },
      ]
      mockExa.getContents.mockResolvedValueOnce({ results: mockContent })

      const result = await fetchContentExa('https://example.com', mockContext)

      const parsed = JSON.parse(result)
      expect(parsed.text).toBe('')
    })

    it('should return error message when API key is not configured', async () => {
      mockGetSettings.mockReturnValue({
        exaApiKey: '',
      } as any)

      const result = await fetchContentExa('https://example.com', mockContext)

      expect(result).toBe('Error: Exa API key not configured')
      expect(mockExa.getContents).not.toHaveBeenCalled()
    })

    it('should handle fetch errors gracefully', async () => {
      const error = new Error('Network error')
      mockExa.getContents.mockRejectedValueOnce(error)

      const result = await fetchContentExa('https://example.com', mockContext)

      expect(result).toBe('Error: Error: Network error') // fetchContentExa adds "Error: " prefix to String(error)
      // Error handling tested by checking return value
    })

    it('should handle non-Error exceptions', async () => {
      mockExa.getContents.mockRejectedValueOnce('String error')

      const result = await fetchContentExa('https://example.com', mockContext)

      expect(result).toBe('Error: String error')
    })

    it('should use correct configuration parameters', async () => {
      mockExa.getContents.mockResolvedValueOnce({ results: [{ url: 'https://example.com', text: 'content' }] })

      await fetchContentExa('https://example.com', mockContext)

      expect(mockExa.getContents).toHaveBeenCalledWith(['https://example.com'], {
        text: {
          maxCharacters: 8000,
          includeHtmlTags: false,
        },
      })
    })

    it('should handle different URL formats', async () => {
      const urls = [
        'https://example.com',
        'http://example.com',
        'https://subdomain.example.com/path?query=1',
        'https://example.com/page#anchor',
      ]

      for (const url of urls) {
        mockExa.getContents.mockResolvedValueOnce({ results: [{ url, text: 'content' }] })
        await fetchContentExa(url, mockContext)
        expect(mockExa.getContents).toHaveBeenCalledWith([url], expect.any(Object))
      }
    })
  })
})
