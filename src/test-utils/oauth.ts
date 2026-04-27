/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthTokens } from '@/lib/auth'
import type { GoogleUserInfo } from '@/integrations/google/types'
import { clearOAuthState } from '@/lib/oauth-state'

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
 * Clean up OAuth state from sqlite settings
 * This replaces the old cleanupSessionStorage function
 */
export const cleanupSessionStorage = async () => {
  await clearOAuthState()
}
