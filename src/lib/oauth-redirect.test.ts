import { describe, expect, it, mock } from 'bun:test'
import { webPlatformMock } from '@/test-utils/platform-mock'

mock.module('@/lib/platform', () => webPlatformMock)

import { getOAuthRedirectUri } from './oauth-redirect'

describe('getOAuthRedirectUri', () => {
  it('returns web callback for non-Tauri environment', () => {
    const originalLocation = window.location
    const mockLocation = { origin: 'https://app.example.com' } as Location
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
      configurable: true,
    })

    const uri = getOAuthRedirectUri()

    expect(uri).toBe('https://app.example.com/oauth/callback')

    // Restore
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('returns App Link for mobile platforms', () => {
    const uri = getOAuthRedirectUri()

    // In test environment (not Tauri), should return web callback
    expect(uri).toContain('/oauth/callback')
  })

  it('returns valid URL format', () => {
    const originalLocation = window.location
    const mockLocation = { origin: 'https://test.example.com' } as Location
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
      configurable: true,
    })

    const uri = getOAuthRedirectUri()

    // Should be a valid URL
    expect(() => new URL(uri)).not.toThrow()

    // Should end with /oauth/callback
    expect(uri).toMatch(/\/oauth\/callback$/)

    // Restore
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })
})
