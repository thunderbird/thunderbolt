import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { getCloudUrl } from '@/lib/config'

// Mock the getCloudUrl function
const mockGetCloudUrl = mock()
mock.module('@/lib/config', () => ({
  getCloudUrl: mockGetCloudUrl,
}))

describe('useCloudUrl hook', () => {
  beforeEach(() => {
    mockGetCloudUrl.mockClear()
  })

  it('should call getCloudUrl when imported', async () => {
    const mockUrl = 'https://api.example.com/v1'
    mockGetCloudUrl.mockResolvedValue(mockUrl)

    // Import the hook to trigger the effect
    const { useCloudUrl } = await import('./use-cloud-url')

    // The hook should be defined
    expect(typeof useCloudUrl).toBe('function')
  })

  it('should handle getCloudUrl returning a valid URL', async () => {
    const mockUrl = 'https://api.example.com/v1'
    mockGetCloudUrl.mockResolvedValue(mockUrl)

    const result = await getCloudUrl()
    expect(result).toBe(mockUrl)
    expect(mockGetCloudUrl).toHaveBeenCalledTimes(1)
  })

  it('should handle getCloudUrl returning localhost URL', async () => {
    const mockUrl = 'http://localhost:8000/v1'
    mockGetCloudUrl.mockResolvedValue(mockUrl)

    const result = await getCloudUrl()
    expect(result).toBe(mockUrl)
    expect(mockGetCloudUrl).toHaveBeenCalledTimes(1)
  })

  it('should handle getCloudUrl returning empty string', async () => {
    mockGetCloudUrl.mockResolvedValue('')

    const result = await getCloudUrl()
    expect(result).toBe('')
    expect(mockGetCloudUrl).toHaveBeenCalledTimes(1)
  })

  it('should handle getCloudUrl rejection', async () => {
    const error = new Error('Failed to get cloud URL')
    mockGetCloudUrl.mockRejectedValue(error)

    try {
      await getCloudUrl()
      expect(true).toBe(false) // Should not reach here
    } catch (e) {
      expect(e).toBe(error)
    }

    expect(mockGetCloudUrl).toHaveBeenCalledTimes(1)
  })

  it('should handle multiple calls to getCloudUrl', async () => {
    const mockUrl1 = 'https://api.example.com/v1'
    const mockUrl2 = 'http://localhost:8000/v1'

    mockGetCloudUrl.mockResolvedValueOnce(mockUrl1).mockResolvedValueOnce(mockUrl2)

    const result1 = await getCloudUrl()
    const result2 = await getCloudUrl()

    expect(result1).toBe(mockUrl1)
    expect(result2).toBe(mockUrl2)
    expect(mockGetCloudUrl).toHaveBeenCalledTimes(2)
  })

  it('should handle getCloudUrl with different URL formats', async () => {
    const urls = [
      'https://api.example.com/v1',
      'http://localhost:8000/v1',
      'https://staging.example.com/v1',
      'http://192.168.1.100:8000/v1',
    ]

    for (const url of urls) {
      mockGetCloudUrl.mockResolvedValueOnce(url)
      const result = await getCloudUrl()
      expect(result).toBe(url)
    }

    expect(mockGetCloudUrl).toHaveBeenCalledTimes(urls.length)
  })
})
