/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  OAuth2Server,
  type MutableResponse,
  type MutableToken,
  type TokenRequestIncomingMessage,
} from 'oauth2-mock-server'
import type { FullConfig } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { createFakeProvider } from './fake-provider'
import { createFakeMcpServer } from './fake-mcp-server'
import { adminSpareIdpSecretPrefix, createLoginHintIdp } from './admin/mock-idp'
import { createMockSamlIdp } from './mock-saml-idp'
import { createMockDns } from './admin/mock-dns'

const mockOidcPort = Number(process.env.MOCK_OIDC_PORT ?? 9876)
const mockSamlPort = Number(process.env.MOCK_SAML_PORT ?? 9877)
const identityClaims = z.object({ sub: z.string(), email: z.email() })

const globalSetup = async (config: FullConfig) => {
  // One shared OIDC/SAML user is only safe while specs run one at a time; parallel workers would overlap its
  // sessions, devices and settings on the same backend.
  const uniqueUsers = process.env.E2E_EXTENDED_UNIQUE_USERS === 'true' || config.workers > 1
  // --- Mock OIDC server ---
  const oidcServer = new OAuth2Server()
  await oidcServer.issuer.keys.generate('RS256')

  oidcServer.service.on('beforeTokenSigning', (token: MutableToken, request: TokenRequestIncomingMessage) => {
    if (!uniqueUsers) {
      Object.assign(token.payload, {
        sub: 'e2e-test-user',
        email: 'e2e@thunderbolt.test',
        name: 'E2E Test User',
        email_verified: true,
      })
      return
    }
    if (!request.body.code) {
      throw new Error('Mock OIDC authorization code is missing')
    }
    const suffix = createHash('sha256').update(request.body.code).digest('hex').slice(0, 16)
    token.payload.sub = `e2e-${suffix}`
    token.payload.email = `e2e-${suffix}@thunderbolt.test`
    token.payload.name = 'E2E Test User'
    token.payload.email_verified = true
  })

  oidcServer.service.on('beforeUserinfo', (userInfoResponse: MutableResponse, request: IncomingMessage) => {
    if (uniqueUsers) {
      const claims = identityClaims.parse(
        JSON.parse(Buffer.from(request.headers.authorization?.split('.')[1] ?? '', 'base64url').toString()),
      )
      userInfoResponse.body = { ...claims, name: 'E2E Test User', email_verified: true }
      return
    }
    userInfoResponse.body = {
      sub: 'e2e-test-user',
      email: 'e2e@thunderbolt.test',
      name: 'E2E Test User',
      email_verified: true,
    }
  })

  await oidcServer.start(mockOidcPort, 'localhost')
  console.log(`Mock OIDC server started on port ${mockOidcPort}`)

  // --- Mock SAML IdP ---
  const samlServer = await createMockSamlIdp(mockSamlPort, { uniqueUsers })

  const fakeProvider = await createFakeProvider(Number(process.env.FAKE_PROVIDER_PORT ?? 9878))
  const fakeMcpServer = process.env.E2E_EXTENDED_MCP === 'true' ? await createFakeMcpServer(9879) : undefined

  // --- Admin IdPs: the env connection's, and a spare for specs that register their own. The spare
  // checks the client secret, so a rotation test proves the new secret is the one in use. ---
  const adminIdps = await Promise.all([
    createLoginHintIdp(Number(process.env.ADMIN_ENV_IDP_PORT ?? 9882)),
    createLoginHintIdp(Number(process.env.ADMIN_SPARE_IDP_PORT ?? 9883), {
      acceptsClientSecret: (secret) => secret.startsWith(adminSpareIdpSecretPrefix),
    }),
  ])

  // --- DNS for the admin backend (`TEST_DNS_SERVERS`), so a spec can verify a domain ---
  const adminDns = await createMockDns(
    Number(process.env.ADMIN_DNS_PORT ?? 9884),
    Number(process.env.ADMIN_DNS_CONTROL_PORT ?? 9885),
  )

  // Store references for teardown
  ;(globalThis as Record<string, unknown>).__oidcServer = oidcServer
  ;(globalThis as Record<string, unknown>).__samlServer = samlServer
  ;(globalThis as Record<string, unknown>).__fakeProvider = fakeProvider
  Object.assign(globalThis, { __fakeMcpServer: fakeMcpServer, __adminIdps: adminIdps, __adminDns: adminDns })
}

export default globalSetup
