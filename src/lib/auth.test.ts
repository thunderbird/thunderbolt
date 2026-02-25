import { beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock provider modules BEFORE importing auth to ensure the providers
// object is initialised with the mocks.

const mockGoogleBuildAuthUrl = mock(async () => 'https://accounts.google.com/auth')
const mockGoogleExchangeCodeForTokens = mock(async () => ({
  access_token: 'token',
  expires_in: 3600,
  token_type: 'Bearer',
}))

mock.module('@/integrations/google/auth', () => ({
  buildAuthUrl: mockGoogleBuildAuthUrl,
  exchangeCodeForTokens: mockGoogleExchangeCodeForTokens,
  getOAuthConfig: async () => ({ clientId: 'id', redirectUri: 'http://default', scope: '' }),
  getUserInfo: async () => ({ id: '1', email: 'g@test.com', verified_email: true, name: 'G' }),
  refreshAccessToken: async () => ({ access_token: 'new', expires_in: 3600, token_type: 'Bearer' }),
}))

mock.module('@/integrations/microsoft/auth', () => ({
  buildAuthUrl: mock(async () => 'https://login.microsoftonline.com/auth'),
  exchangeCodeForTokens: mock(async () => ({ access_token: 'token', expires_in: 3600, token_type: 'Bearer' })),
  getOAuthConfig: async () => ({ clientId: 'id', redirectUri: 'http://default', scope: '' }),
  getUserInfo: async () => ({ id: '1', email: 'm@test.com', verified_email: true, name: 'M' }),
  refreshAccessToken: async () => ({ access_token: 'new', expires_in: 3600, token_type: 'Bearer' }),
}))

const { buildAuthUrl, exchangeCodeForTokens } = await import('./auth')

beforeEach(() => {
  mockGoogleBuildAuthUrl.mockClear()
  mockGoogleExchangeCodeForTokens.mockClear()
})

describe('buildAuthUrl wrapper', () => {
  it('forwards explicit redirectUri to provider', async () => {
    await buildAuthUrl('google', 'state', 'challenge', 'http://localhost:17421')

    expect(mockGoogleBuildAuthUrl).toHaveBeenCalledWith('state', 'challenge', 'http://localhost:17421')
  })

  it('forwards undefined to provider when redirectUri is omitted', async () => {
    await buildAuthUrl('google', 'state', 'challenge')

    expect(mockGoogleBuildAuthUrl).toHaveBeenCalledWith('state', 'challenge', undefined)
  })
})

describe('exchangeCodeForTokens wrapper', () => {
  it('forwards explicit redirectUri to provider', async () => {
    await exchangeCodeForTokens('google', 'code', 'verifier', 'http://localhost:17421')

    expect(mockGoogleExchangeCodeForTokens).toHaveBeenCalledWith('code', 'verifier', 'http://localhost:17421')
  })

  it('forwards undefined to provider when redirectUri is omitted', async () => {
    await exchangeCodeForTokens('google', 'code', 'verifier')

    expect(mockGoogleExchangeCodeForTokens).toHaveBeenCalledWith('code', 'verifier', undefined)
  })
})
