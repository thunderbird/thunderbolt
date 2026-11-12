/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { http } from '@/lib/http'
import { fetch as nativeFetch } from '@/lib/fetch'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import {
  createProviderAuthorization,
  createOAuthRequestSignal,
  type OpenRouterAuthDependencies,
} from '@/lib/openrouter-auth'

export const defaultOtariOrigin = 'https://otari.ai'

/** Resolve the hosted dashboard and inference service, or a self-hosted gateway. */
export const getOtariEndpoints = (origin: string) => {
  const base = normalizeOtariOrigin(origin)
  return {
    dashboard: base === defaultOtariOrigin ? `${base}/dashboard/` : `${base}/`,
    api: `${base}/api/v1`,
    inference: base === defaultOtariOrigin ? 'https://api.otari.ai/api/v1' : `${base}/api/v1`,
  }
}

/** Require an explicit secure Otari origin, allowing loopback development. */
export const normalizeOtariOrigin = (value: string): string => {
  const url = new URL(value)
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Enter an HTTPS Otari origin, or a local development origin.')
  }
  return url.origin
}

/** Recover the sign-in origin from a saved inference URL, including the hosted split-domain deployment. */
export const getOtariAuthorizationOrigin = (value?: string | null): string => {
  if (!value) {
    return defaultOtariOrigin
  }
  const url = new URL(value.trim().replace(/\/+$/, ''))
  if (url.pathname !== '/' && url.pathname !== '/api/v1') {
    throw new Error('Enter an Otari server origin or API endpoint')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Otari URL')
  }
  const origin = normalizeOtariOrigin(url.origin)
  return origin === new URL(getOtariEndpoints(defaultOtariOrigin).inference).origin ? defaultOtariOrigin : origin
}

/** Build the same PKCE authorization request for browser redirects and native loopback flows. */
export const getOtariAuthorizationUrl = (
  origin: string,
  { challenge, redirectUri, state }: { challenge: string; redirectUri: string; state: string },
): string =>
  `${getOtariEndpoints(origin).api}/oauth/apps/authorize?${new URLSearchParams({
    client_id: 'thunderbolt',
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`

/** Authorize through the desktop app’s external browser and loopback callback. */
export const connectOtari = async (
  origin: string,
  callerSignal: AbortSignal,
  dependencies: Partial<OpenRouterAuthDependencies> = {},
): Promise<string> => {
  const signal = AbortSignal.any([callerSignal, getIdentitySignal()])
  const endpoints = getOtariEndpoints(origin)
  const flow = createProviderAuthorization(
    {
      authorizationEndpoint: `${endpoints.api}/oauth/apps/authorize`,
      authorizationResponseIssuer: normalizeOtariOrigin(origin),
      buildUrl: (challenge, redirectUri, state) => getOtariAuthorizationUrl(origin, { challenge, redirectUri, state }),
    },
    dependencies,
  )
  try {
    const grant = await flow.startConnection({ signal })
    return await exchangeOtariCode(origin, grant, signal)
  } catch {
    signal.throwIfAborted()
    throw new Error('Could not connect to Otari. Please try again.')
  }
}

/** Exchange a one-use, PKCE-bound grant directly with the selected Otari server. */
export const exchangeOtariCode = async (
  origin: string,
  { code, verifier, redirectUri }: { code: string; verifier: string; redirectUri: string },
  signal: AbortSignal,
): Promise<string> => {
  signal.throwIfAborted()
  const endpoints = getOtariEndpoints(origin)
  const response = await http
    .post(`${endpoints.api}/oauth/apps/token`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'thunderbolt',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      credentials: 'omit',
      redirect: 'error',
      fetch: nativeFetch,
      signal: createOAuthRequestSignal(signal),
    })
    .json<unknown>()
  if (
    typeof response !== 'object' ||
    response === null ||
    !('access_token' in response) ||
    typeof response.access_token !== 'string' ||
    !response.access_token.trim()
  ) {
    throw new Error('Invalid Otari token response')
  }
  if (signal.aborted) {
    await revokeOtariToken(origin, response.access_token)
    signal.throwIfAborted()
  }
  return response.access_token
}

/** Revoke only the delegated key itself; never send cookies or follow a credential-bearing redirect. */
export const revokeOtariToken = async (origin: string, token: string): Promise<void> => {
  await http.post(`${getOtariEndpoints(origin).api}/oauth/apps/revoke`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
    credentials: 'omit',
    redirect: 'error',
    fetch: nativeFetch,
    // Cleanup must still complete after a cancelled connection or account switch.
    signal: AbortSignal.timeout(30_000),
  })
}
