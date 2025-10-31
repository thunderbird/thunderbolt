import type { OAuthTokens } from '@/lib/auth'
import type { GoogleUserInfo } from '@/integrations/google/types'

/**
 * Mock OAuth tokens for testing
 */
export const mockOAuthTokens = (): OAuthTokens => ({
  access_token: 'mock_access_token_12345',
  refresh_token: 'mock_refresh_token_67890',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'email profile openid',
})

/**
 * Mock user info for testing
 */
export const mockUserInfo = (): GoogleUserInfo => ({
  email: 'test@example.com',
  name: 'Test User',
  picture: 'https://example.com/picture.jpg',
  id: '123456789',
  verified_email: true,
  given_name: 'Test',
  family_name: 'User',
  locale: 'en',
})

/**
 * Mock successful OAuth flow result
 */
export const mockOAuthSuccess = () => ({
  tokens: mockOAuthTokens(),
  userInfo: mockUserInfo(),
})

/**
 * Mock OAuth callback data
 */
export const mockOAuthCallbackData = () => ({
  code: 'mock_auth_code_12345',
  state: 'mock_state_67890',
})

/**
 * Mock OAuth error callback data
 */
export const mockOAuthErrorCallbackData = () => ({
  error: 'access_denied',
  error_description: 'The user denied the request',
})

/**
 * Mock session storage for OAuth flow
 */
export const mockSessionStorage = (provider: 'google' | 'microsoft' = 'google') => {
  const state = 'mock_state_67890'
  const verifier = 'mock_verifier_12345'

  return {
    oauth_state: state,
    oauth_provider: provider,
    oauth_verifier: verifier,
    oauth_return_context: 'onboarding',
  }
}

/**
 * Setup session storage with OAuth data
 */
export const setupSessionStorage = (provider: 'google' | 'microsoft' = 'google') => {
  const data = mockSessionStorage(provider)

  Object.entries(data).forEach(([key, value]) => {
    sessionStorage.setItem(key, value)
  })

  return data
}

/**
 * Clean up session storage
 */
export const cleanupSessionStorage = () => {
  const keys = ['oauth_state', 'oauth_provider', 'oauth_verifier', 'oauth_return_context']

  keys.forEach((key) => {
    sessionStorage.removeItem(key)
  })
}
