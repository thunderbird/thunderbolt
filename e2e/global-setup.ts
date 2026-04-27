/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OAuth2Server } from 'oauth2-mock-server'

const mockOidcPort = Number(process.env.MOCK_OIDC_PORT ?? 9876)

const globalSetup = async () => {
  const server = new OAuth2Server()
  await server.issuer.keys.generate('RS256')

  // Auto-populate token claims for every issued token (id_token + access_token)
  server.service.on('beforeTokenSigning', (token: Record<string, unknown>) => {
    token.sub = 'e2e-test-user'
    token.email = 'e2e@thunderbolt.test'
    token.name = 'E2E Test User'
    token.email_verified = true
  })

  // Customize /userinfo response — Better Auth calls this to get user claims
  server.service.on(
    'beforeUserinfo',
    (userInfoResponse: { body: Record<string, unknown>; statusCode: number }) => {
      userInfoResponse.body = {
        sub: 'e2e-test-user',
        email: 'e2e@thunderbolt.test',
        name: 'E2E Test User',
        email_verified: true,
      }
    },
  )

  await server.start(mockOidcPort, 'localhost')
  console.log(`Mock OIDC server started on port ${mockOidcPort}`)

  // Store reference for teardown
  ;(globalThis as Record<string, unknown>).__oidcServer = server
}

export default globalSetup
