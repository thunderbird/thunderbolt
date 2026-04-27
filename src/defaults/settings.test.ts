import { describe, expect, it, mock } from 'bun:test'

// Mock isOidcMode before importing settings
const mockIsOidcMode = mock(() => false)
mock.module('@/lib/auth-mode', () => ({
  isOidcMode: mockIsOidcMode,
}))

import { getDefaultDataCollectionValue } from './settings'

describe('getDefaultDataCollectionValue', () => {
  it('returns false when isOidcMode is true', () => {
    mockIsOidcMode.mockReturnValue(true)
    expect(getDefaultDataCollectionValue()).toBe(false)
  })

  it('returns true when isOidcMode is false', () => {
    mockIsOidcMode.mockReturnValue(false)
    expect(getDefaultDataCollectionValue()).toBe(true)
  })
})
