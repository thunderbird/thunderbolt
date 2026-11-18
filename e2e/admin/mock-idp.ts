/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  OAuth2Server,
  type MutableResponse,
  type MutableToken,
  type TokenRequestIncomingMessage,
} from 'oauth2-mock-server'
import type { IncomingMessage } from 'node:http'

/** The spare IdP accepts only client secrets with this prefix: any other is refused at the token endpoint. */
export const adminSpareIdpSecretPrefix = 'e2e-valid-'

export type IdpIdentity = { sub: string; email: string; name?: string }

/** `login_hint` carries the identity to sign in as: `<sub>|<email>`, as `routeIdpIdentity` sets it. */
export const encodeLoginHint = ({ sub, email }: IdpIdentity) => `${sub}|${email}`

const decodeLoginHint = (hint: string | null): IdpIdentity => {
  const [sub, email] = hint?.split('|') ?? []
  return sub && email ? { sub, email } : { sub: 'admin-idp-user', email: 'idp-user@thunderbolt.test' }
}

const claimsOf = (identity: IdpIdentity) => ({
  sub: identity.sub,
  email: identity.email,
  name: identity.name ?? identity.email.split('@')[0],
  email_verified: true,
})

/** The client secret of a token request, from its Basic auth header or its body. */
const clientSecretOf = (request: TokenRequestIncomingMessage) => {
  const basic = request.headers.authorization?.match(/^Basic (.+)$/)?.[1]
  if (basic) {
    const [, secret] = Buffer.from(basic, 'base64').toString().split(':')
    return decodeURIComponent(secret ?? '')
  }
  const { client_secret: secret } = request.body as { client_secret?: unknown }
  return typeof secret === 'string' ? secret : ''
}

/**
 * A mock OIDC IdP that signs in whoever the authorize request's `login_hint` names, so one IdP
 * serves every admin spec. The identity rides the authorization code to the token and userinfo.
 * With `acceptsClientSecret`, a token request whose client secret it refuses gets `invalid_client`.
 */
export const createLoginHintIdp = async (
  port: number,
  { acceptsClientSecret }: { acceptsClientSecret?: (secret: string) => boolean } = {},
) => {
  const server = new OAuth2Server()
  await server.issuer.keys.generate('RS256')
  const identityByCode = new Map<string, IdpIdentity>()

  server.service.on('beforeAuthorizeRedirect', ({ url }: { url: URL }, req: IncomingMessage) => {
    const hint = new URL(req.url ?? '/', 'http://localhost').searchParams.get('login_hint')
    const code = url.searchParams.get('code')
    if (code) {
      identityByCode.set(code, decodeLoginHint(hint))
    }
  })

  server.service.on('beforeTokenSigning', (token: MutableToken, request: TokenRequestIncomingMessage) => {
    const identity = identityByCode.get(String(request.body.code)) ?? decodeLoginHint(null)
    Object.assign(token.payload, claimsOf(identity))
  })

  if (acceptsClientSecret) {
    server.service.on('beforeResponse', (response: MutableResponse, request: TokenRequestIncomingMessage) => {
      if (!acceptsClientSecret(clientSecretOf(request))) {
        response.statusCode = 401
        response.body = { error: 'invalid_client' }
      }
    })
  }

  server.service.on('beforeUserinfo', (response: MutableResponse, request: IncomingMessage) => {
    const payload = JSON.parse(
      Buffer.from(request.headers.authorization?.split('.')[1] ?? '', 'base64url').toString() || '{}',
    ) as Partial<IdpIdentity>
    response.body = claimsOf(payload.sub && payload.email ? (payload as IdpIdentity) : decodeLoginHint(null))
  })

  await server.start(port, 'localhost')
  return server
}
