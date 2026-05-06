/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OAuth2Server } from 'oauth2-mock-server'
import { createMockSamlIdp } from './mock-saml-idp'

const mockOidcPort = Number(process.env.MOCK_OIDC_PORT ?? 9876)
const mockSamlPort = Number(process.env.MOCK_SAML_PORT ?? 9877)

const globalSetup = async () => {
  // --- Mock OIDC server ---
  const oidcServer = new OAuth2Server()
  await oidcServer.issuer.keys.generate('RS256')

  oidcServer.service.on('beforeTokenSigning', (token: Record<string, unknown>) => {
    token.sub = 'e2e-test-user'
    token.email = 'e2e@thunderbolt.test'
    token.name = 'E2E Test User'
    token.email_verified = true
  })

  oidcServer.service.on(
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

  await oidcServer.start(mockOidcPort, 'localhost')
  console.log(`Mock OIDC server started on port ${mockOidcPort}`)

  // --- Mock SAML IdP ---
  const samlServer = await createMockSamlIdp(mockSamlPort)

  // Store references for teardown
  ;(globalThis as Record<string, unknown>).__oidcServer = oidcServer
  ;(globalThis as Record<string, unknown>).__samlServer = samlServer
}

export default globalSetup
