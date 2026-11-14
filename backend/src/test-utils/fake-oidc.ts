/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { exportJWK, generateKeyPair, SignJWT } from 'jose'

/** The id token's audience: every fake IdP registers the app under this client id. */
export const fakeOidcClientId = 'thunderbolt-app'

const callbackURL = 'http://localhost:1420/'

const discoveryDocumentFor = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
})

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ')

export type FakeOidcSignIn = {
  status: number
  /** Where the callback redirects: the app on success, `?error=…` on a refusal. */
  location: string | null
  /** The session cookie the callback set, empty when it set none. */
  cookie: string
}

/**
 * Several OIDC identity providers in one process, one per issuer, answering discovery, token and
 * JWKS requests through a stand-in `fetch`. `signIn` runs a full authorization-code sign-in against
 * an app; `setReachable(false)` makes every IdP request fail as an outage would. `requests` lists
 * every IdP URL fetched, reachable or not.
 */
export const createFakeOidcIdps = async (issuers: string[]) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256' }
  const requests: string[] = []
  const idTokens = new Map<string, string>()
  let reachable = true

  const issuerOf = (url: string) => issuers.find((issuer) => url.startsWith(`${issuer}/`))

  const idpFetch = async (...[input]: Parameters<typeof fetch>) => {
    const url = input instanceof Request ? input.url : input.toString()
    const issuer = issuerOf(url)
    if (!issuer) {
      throw new Error(`Unexpected request: ${url}`)
    }
    requests.push(url)
    if (!reachable) {
      throw new TypeError('fetch failed')
    }
    const discovery = discoveryDocumentFor(issuer)
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json(discovery)
    }
    if (url === discovery.token_endpoint) {
      return Response.json({ access_token: 'idp-access-token', token_type: 'Bearer', id_token: idTokens.get(issuer) })
    }
    if (url === discovery.jwks_uri) {
      return Response.json({ keys: [publicJwk] })
    }
    throw new Error(`Unexpected IdP request: ${url}`)
  }

  /**
   * Run `fn` with these IdPs as the process's `fetch` and their origins trusted. Better Auth's SSO
   * plugin fetches through the global and checks issuers against `TRUSTED_ORIGINS`.
   */
  const withIdps = async <T>(fn: () => Promise<T>) => {
    const savedFetch = globalThis.fetch
    const savedOrigins = process.env.TRUSTED_ORIGINS
    globalThis.fetch = Object.assign(idpFetch, { preconnect: savedFetch.preconnect }) as typeof fetch
    process.env.TRUSTED_ORIGINS = ['http://localhost:1420', ...issuers].join(',')
    try {
      return await fn()
    } finally {
      globalThis.fetch = savedFetch
      // Assigning undefined would store the string "undefined" on newer Bun.
      if (savedOrigins === undefined) {
        delete process.env.TRUSTED_ORIGINS
      } else {
        process.env.TRUSTED_ORIGINS = savedOrigins
      }
    }
  }

  /** Sign in through `providerId`, whose IdP at `issuer` vouches for `subject` and `email`. */
  const signIn = async (
    app: { handle: (request: Request) => Promise<Response> },
    {
      providerId,
      issuer,
      subject,
      email,
      claims = { email_verified: true },
    }: { providerId: string; issuer: string; subject: string; email: string; claims?: Record<string, unknown> },
  ): Promise<FakeOidcSignIn> => {
    idTokens.set(
      issuer,
      await new SignJWT({ email, name: 'SSO User', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setAudience(fakeOidcClientId)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey),
    )
    return withIdps(async () => {
      const start = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in/sso', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId, callbackURL }),
        }),
      )
      if (!start.ok) {
        return { status: start.status, location: null, cookie: '' }
      }
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
      const callback = await app.handle(
        new Request(`http://localhost/v1/api/auth/sso/callback/${providerId}?code=idp-code&state=${state}`, {
          headers: { Cookie: cookieOf(start) },
        }),
      )
      return { status: callback.status, location: callback.headers.get('location'), cookie: cookieOf(callback) }
    })
  }

  return {
    signIn,
    withIdps,
    requests,
    setReachable: (value: boolean) => {
      reachable = value
    },
  }
}

export type FakeOidcIdps = Awaited<ReturnType<typeof createFakeOidcIdps>>
