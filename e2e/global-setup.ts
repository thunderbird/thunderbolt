import { OAuth2Server } from 'oauth2-mock-server'

const MOCK_OIDC_PORT = 9876

let server: OAuth2Server

const globalSetup = async () => {
  server = new OAuth2Server()
  await server.issuer.keys.generate('RS256')

  // Auto-populate token claims for every issued token
  server.service.on('beforeTokenSigning', (token: Record<string, unknown>) => {
    token.sub = 'e2e-test-user'
    token.email = 'e2e@thunderbolt.test'
    token.name = 'E2E Test User'
    token.email_verified = true
  })

  await server.start(MOCK_OIDC_PORT, 'localhost')
  console.log(`Mock OIDC server started on port ${MOCK_OIDC_PORT}`)

  // Store reference for teardown
  ;(globalThis as Record<string, unknown>).__oidcServer = server
}

export default globalSetup
