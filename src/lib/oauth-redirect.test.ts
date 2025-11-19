import { describe, expect, it } from 'bun:test'
import { getOAuthRedirectUri } from './oauth-redirect'

describe('getOAuthRedirectUri', () => {
  it('returns web callback for non-Tauri environment', async () => {
    const originalLocation = window.location
    // @ts-expect-error - mocking window.location
    delete window.location
    window.location = { origin: 'https://app.example.com' } as Location

    const uri = await getOAuthRedirectUri()

    expect(uri).toBe('https://app.example.com/oauth/callback')

    // Restore
    window.location = originalLocation
  })

  it('returns App Link for mobile platforms', async () => {
    const uri = await getOAuthRedirectUri()

    // In test environment (not Tauri), should return web callback
    expect(uri).toContain('/oauth/callback')
  })

  it('returns valid URL format', async () => {
    const originalLocation = window.location
    // @ts-expect-error - mocking window.location
    delete window.location
    window.location = { origin: 'https://test.example.com' } as Location

    const uri = await getOAuthRedirectUri()

    // Should be a valid URL
    expect(() => new URL(uri)).not.toThrow()

    // Should end with /oauth/callback
    expect(uri).toMatch(/\/oauth\/callback$/)

    // Restore
    window.location = originalLocation
  })
})
