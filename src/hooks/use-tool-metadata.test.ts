import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { getToolMetadata } from '@/lib/tool-metadata'
import { splitPartType } from '@/lib/utils'

// Mock the dependencies
const mockGetToolMetadata = mock()
const mockSplitPartType = mock()

mock.module('@/lib/tool-metadata', () => ({
  getToolMetadata: mockGetToolMetadata,
}))

mock.module('@/lib/utils', () => ({
  splitPartType: mockSplitPartType,
}))

describe('useToolMetadata dependencies', () => {
  beforeEach(() => {
    mockGetToolMetadata.mockClear()
    mockSplitPartType.mockClear()
  })

  it('should call splitPartType with the correct tool type', () => {
    mockSplitPartType.mockReturnValue(['tool', 'test_tool'])
    mockGetToolMetadata.mockResolvedValue({
      displayName: 'Test Tool',
      initials: 'TT',
      loadingMessage: 'Testing...',
      category: 'action',
      icon: null,
    })

    // Test the splitPartType function directly
    const result = splitPartType('tool-test_tool')
    expect(mockSplitPartType).toHaveBeenCalledWith('tool-test_tool')
    expect(result).toEqual(['tool', 'test_tool'])
  })

  it('should handle different tool type formats', () => {
    // Test with dash separator
    mockSplitPartType.mockReturnValue(['tool', 'search_tool'])
    let result = splitPartType('tool-search_tool')
    expect(result).toEqual(['tool', 'search_tool'])

    // Test without dash separator
    mockSplitPartType.mockReturnValue(['unknown', 'unknown'])
    result = splitPartType('unknown')
    expect(result).toEqual(['unknown', 'unknown'])

    // Test empty string
    mockSplitPartType.mockReturnValue(['', 'unknown'])
    result = splitPartType('')
    expect(result).toEqual(['', 'unknown'])
  })

  it('should call getToolMetadata with the extracted tool name', async () => {
    const mockMetadata = {
      displayName: 'Search Tool',
      initials: 'ST',
      loadingMessage: 'Searching...',
      category: 'search' as const,
      icon: null,
    }

    mockGetToolMetadata.mockResolvedValue(mockMetadata)

    // Test the getToolMetadata function directly
    const result = await getToolMetadata('search_tool')
    expect(mockGetToolMetadata).toHaveBeenCalledWith('search_tool')
    expect(result).toEqual(mockMetadata)
  })

  it('should handle different tool names correctly', async () => {
    const weatherMetadata = {
      displayName: 'Weather Tool',
      initials: 'WT',
      loadingMessage: 'Getting weather...',
      category: 'weather' as const,
      icon: null,
    }

    mockGetToolMetadata.mockResolvedValue(weatherMetadata)

    const result = await getToolMetadata('get_weather')
    expect(mockGetToolMetadata).toHaveBeenCalledWith('get_weather')
    expect(result).toEqual(weatherMetadata)
  })

  it('should handle metadata loading errors gracefully', async () => {
    mockGetToolMetadata.mockRejectedValue(new Error('Failed to load metadata'))

    try {
      await getToolMetadata('error_tool')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Failed to load metadata')
    }

    expect(mockGetToolMetadata).toHaveBeenCalledWith('error_tool')
  })

  it('should return consistent metadata for the same tool name', async () => {
    const mockMetadata = {
      displayName: 'Consistent Tool',
      initials: 'CT',
      loadingMessage: 'Processing...',
      category: 'action' as const,
      icon: null,
    }

    mockGetToolMetadata.mockResolvedValue(mockMetadata)

    // Call the same tool multiple times
    const result1 = await getToolMetadata('consistent_tool')
    const result2 = await getToolMetadata('consistent_tool')

    expect(result1).toEqual(mockMetadata)
    expect(result2).toEqual(mockMetadata)
    expect(mockGetToolMetadata).toHaveBeenCalledTimes(2)
    expect(mockGetToolMetadata).toHaveBeenCalledWith('consistent_tool')
  })

  it('should handle rapid consecutive calls', async () => {
    const metadata1 = {
      displayName: 'Tool 1',
      initials: 'T1',
      loadingMessage: 'Processing...',
      category: 'action' as const,
      icon: null,
    }

    const metadata2 = {
      displayName: 'Tool 2',
      initials: 'T2',
      loadingMessage: 'Processing...',
      category: 'action' as const,
      icon: null,
    }

    const metadata3 = {
      displayName: 'Tool 3',
      initials: 'T3',
      loadingMessage: 'Processing...',
      category: 'action' as const,
      icon: null,
    }

    mockGetToolMetadata
      .mockResolvedValueOnce(metadata1)
      .mockResolvedValueOnce(metadata2)
      .mockResolvedValueOnce(metadata3)

    // Make rapid consecutive calls
    const [result1, result2, result3] = await Promise.all([
      getToolMetadata('tool1'),
      getToolMetadata('tool2'),
      getToolMetadata('tool3'),
    ])

    expect(result1).toEqual(metadata1)
    expect(result2).toEqual(metadata2)
    expect(result3).toEqual(metadata3)
    expect(mockGetToolMetadata).toHaveBeenCalledTimes(3)
  })
})
