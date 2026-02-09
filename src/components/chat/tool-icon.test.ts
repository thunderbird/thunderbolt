import { describe, expect, it } from 'bun:test'
import { getProxiedFaviconUrl } from '@/lib/url-utils'
import { extractFaviconUrl } from './tool-icon'

describe('tool-icon helpers', () => {
  describe('extractFaviconUrl', () => {
    it('should return null for non-favicon tools', () => {
      expect(extractFaviconUrl('get_weather', { temp: 72 })).toBe(null)
      expect(extractFaviconUrl('google_get_email', { subject: 'test' })).toBe(null)
      expect(extractFaviconUrl('custom_tool', { result: 'ok' })).toBe(null)
    })

    it('should extract favicon from fetch_content output', () => {
      const output = {
        content: 'Example content',
        favicon: 'https://example.com/favicon.ico',
      }
      expect(extractFaviconUrl('fetch_content', output)).toBe('https://example.com/favicon.ico')
    })

    it('should extract favicon from search output array', () => {
      const output = [
        {
          title: 'First Result',
          url: 'https://example.com',
          favicon: 'https://example.com/favicon.ico',
        },
        {
          title: 'Second Result',
          url: 'https://other.com',
          favicon: 'https://other.com/favicon.ico',
        },
      ]
      expect(extractFaviconUrl('search', output)).toBe('https://example.com/favicon.ico')
    })

    it('should return null if favicon is missing from fetch_content output', () => {
      const output = {
        content: 'Example content',
      }
      expect(extractFaviconUrl('fetch_content', output)).toBe(null)
    })

    it('should return null if search output array is empty', () => {
      expect(extractFaviconUrl('search', [])).toBe(null)
    })

    it('should return null if first search result has no favicon', () => {
      const output = [
        {
          title: 'First Result',
          url: 'https://example.com',
        },
      ]
      expect(extractFaviconUrl('search', output)).toBe(null)
    })

    it('should handle JSON string input', () => {
      const output = JSON.stringify({
        content: 'Example',
        favicon: 'https://example.com/favicon.ico',
      })
      expect(extractFaviconUrl('fetch_content', output)).toBe('https://example.com/favicon.ico')
    })

    it('should handle JSON string array input', () => {
      const output = JSON.stringify([
        {
          favicon: 'https://example.com/favicon.ico',
        },
      ])
      expect(extractFaviconUrl('search', output)).toBe('https://example.com/favicon.ico')
    })

    it('should return null for malformed output', () => {
      expect(extractFaviconUrl('fetch_content', null)).toBe(null)
      expect(extractFaviconUrl('fetch_content', undefined)).toBe(null)
      expect(extractFaviconUrl('search', null)).toBe(null)
    })
  })

  describe('getProxiedFaviconUrl', () => {
    it('should proxy favicon URL through cloud URL with encoding', () => {
      const favicon = 'https://example.com/favicon.ico'
      const cloudUrl = 'https://cloud.example.com'
      expect(getProxiedFaviconUrl(favicon, cloudUrl)).toBe(
        'https://cloud.example.com/pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico',
      )
    })

    it('should return original URL if cloud URL is empty', () => {
      const favicon = 'https://example.com/favicon.ico'
      expect(getProxiedFaviconUrl(favicon, '')).toBe(favicon)
    })

    it('should handle various URL formats with encoding', () => {
      expect(getProxiedFaviconUrl('https://test.com/icon.png', 'https://proxy.com')).toBe(
        'https://proxy.com/pro/proxy/https%3A%2F%2Ftest.com%2Ficon.png',
      )
      expect(getProxiedFaviconUrl('http://test.com/favicon.ico', 'https://proxy.com')).toBe(
        'https://proxy.com/pro/proxy/http%3A%2F%2Ftest.com%2Ffavicon.ico',
      )
    })

    it('should handle cloud URL without trailing slash', () => {
      expect(getProxiedFaviconUrl('https://example.com/favicon.ico', 'https://cloud.com')).toBe(
        'https://cloud.com/pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico',
      )
    })

    it('should handle cloud URL with trailing slash', () => {
      expect(getProxiedFaviconUrl('https://example.com/favicon.ico', 'https://cloud.com/')).toBe(
        'https://cloud.com//pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico',
      )
    })

    it('should encode special characters in favicon URLs', () => {
      expect(getProxiedFaviconUrl('https://example.com/favicon.ico?v=2', 'https://proxy.com')).toBe(
        'https://proxy.com/pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico%3Fv%3D2',
      )
      expect(getProxiedFaviconUrl('https://example.com/path/to/icon#anchor', 'https://proxy.com')).toBe(
        'https://proxy.com/pro/proxy/https%3A%2F%2Fexample.com%2Fpath%2Fto%2Ficon%23anchor',
      )
    })
  })

  describe('integration scenarios', () => {
    it('should handle complete fetch_content workflow with URL encoding', () => {
      const toolName = 'fetch_content'
      const output = {
        content: 'Page content',
        title: 'Example Page',
        favicon: 'https://example.com/favicon.ico',
      }
      const cloudUrl = 'https://proxy.example.com'

      const favicon = extractFaviconUrl(toolName, output)
      expect(favicon).toBe('https://example.com/favicon.ico')

      const proxiedUrl = getProxiedFaviconUrl(favicon!, cloudUrl)
      expect(proxiedUrl).toBe('https://proxy.example.com/pro/proxy/https%3A%2F%2Fexample.com%2Ffavicon.ico')
    })

    it('should handle complete search workflow with URL encoding', () => {
      const toolName = 'search'
      const output = [
        {
          title: 'Search Result',
          url: 'https://result.com',
          favicon: 'https://result.com/icon.png',
        },
      ]
      const cloudUrl = 'https://proxy.example.com'

      const favicon = extractFaviconUrl(toolName, output)
      expect(favicon).toBe('https://result.com/icon.png')

      const proxiedUrl = getProxiedFaviconUrl(favicon!, cloudUrl)
      expect(proxiedUrl).toBe('https://proxy.example.com/pro/proxy/https%3A%2F%2Fresult.com%2Ficon.png')
    })

    it('should gracefully handle missing favicon in workflow', () => {
      const toolName = 'fetch_content'
      const output = { content: 'No favicon here' }

      const favicon = extractFaviconUrl(toolName, output)
      expect(favicon).toBe(null)
    })
  })

  /**
   * Note: Testing the useToolFavicon hook directly would require @testing-library/react
   * or similar React testing utilities. The hook is tested indirectly through:
   * 1. The Storybook stories (tool-icon.stories.tsx)
   * 2. Integration tests that render the ToolIcon component
   * 3. The helper functions tested above that contain the core logic
   *
   * To add direct hook testing, install @testing-library/react and use:
   * const { result } = renderHook(() => useToolFavicon(...))
   */
})
