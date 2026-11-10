/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { z } from 'zod'
import { i18n } from '@/i18n'
import {
  createProviderAuthorization,
  createOAuthRequestSignal,
  type OpenRouterAuthDependencies,
  type OpenRouterConnectionOptions,
} from './openrouter-auth'
import { fetch as nativeFetch } from './fetch'
import { http, HttpError } from './http'

export const tinfoilClientId =
  import.meta.env.VITE_TINFOIL_CLIENT_ID || 'oauthc_SDVdLmN2tIicRCMaqNGijBTNKZceSmEjwolKnycjrypWSCvN'
export const tinfoilManageSubscriptionUrl = 'https://dash.tinfoil.sh/?tab=billing'
const failed = msg`Could not connect to Tinfoil. Try again, or use an API key.`
const reconnect = msg`Your Tinfoil connection has expired. Reconnect Tinfoil in Settings → Connections.`

/** Safe localized failures; provider responses and tokens never reach the UI or logs. */
export class TinfoilConnectionError extends Error {}
/** A definitive rejected grant must not be retried with the spent refresh token. */
export class TinfoilReauthorizationError extends TinfoilConnectionError {
  constructor() {
    super(i18n._(reconnect))
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().finite(),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
})
export type TinfoilCredentials = {
  authorizationId?: string
  access_token: string
  refresh_token?: string
  expires_at: number
  reauth_required?: boolean
}

/** Builds the same PKCE request for browser, desktop, and verified mobile app links. */
export const getTinfoilAuthorizationUrl = (
  { challenge, redirectUri, state }: { challenge: string; redirectUri: string; state: string },
  clientId = tinfoilClientId,
): string => {
  const url = new URL('https://dash.tinfoil.sh/oauth/authorize')
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'inference:api offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

/** OAuth 2.1 public client: exchange directly with Tinfoil using PKCE, never a Thunderbolt server. */
export const createTinfoilAuth = (clientId = tinfoilClientId, overrides: Partial<OpenRouterAuthDependencies> = {}) => {
  const authorization = createProviderAuthorization(
    {
      authorizationEndpoint: 'https://dash.tinfoil.sh/oauth/authorize',
      callbackPath: '/oauth/tinfoil',
      fixedCallbackPath: true,
      buildUrl: (challenge, redirectUri, state) =>
        getTinfoilAuthorizationUrl({ challenge, redirectUri, state }, clientId),
    },
    overrides,
  )

  const grant = async (params: Record<string, string>, signal?: AbortSignal): Promise<TinfoilCredentials> => {
    try {
      const response = await http
        .post('https://api.tinfoil.sh/oauth/token', {
          body: new URLSearchParams({ ...params, client_id: clientId }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'omit',
          redirect: 'error',
          fetch: overrides.fetch ?? nativeFetch,
          signal: createOAuthRequestSignal(signal),
        })
        .json<unknown>()
      const tokens = tokenSchema.parse(response)
      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof HttpError && error.response.status === 400) {
        const body: unknown = await error.response.json().catch(() => null)
        if (typeof body === 'object' && body !== null && 'error' in body && body.error === 'invalid_grant') {
          throw new TinfoilReauthorizationError()
        }
      }
      throw new TinfoilConnectionError(i18n._(failed))
    }
  }

  const exchangeCode = async (
    { code, verifier, redirectUri }: { code: string; verifier: string; redirectUri: string },
    signal?: AbortSignal,
  ): Promise<TinfoilCredentials> => ({
    ...(await grant(
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri },
      signal,
    )),
    authorizationId: crypto.randomUUID(),
  })

  return {
    exchangeCode,
    startConnection: async (options: OpenRouterConnectionOptions = {}): Promise<TinfoilCredentials> => {
      try {
        const result = await authorization.startConnection(options)
        return await exchangeCode(result, options.signal)
      } catch (error) {
        options.signal?.throwIfAborted()
        if (error instanceof TinfoilConnectionError) {
          throw error
        }
        throw new TinfoilConnectionError(i18n._(failed))
      }
    },
    refresh: async (refreshToken: string): Promise<TinfoilCredentials> => {
      const tokens = await grant({ grant_type: 'refresh_token', refresh_token: refreshToken })
      return { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken }
    },
    revoke: async (token: string): Promise<void> => {
      try {
        await http.post('https://api.tinfoil.sh/oauth/revoke', {
          body: new URLSearchParams({ client_id: clientId, token }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'omit',
          redirect: 'error',
          fetch: overrides.fetch ?? nativeFetch,
          signal: createOAuthRequestSignal(),
        })
      } catch {
        throw new TinfoilConnectionError(i18n._(failed))
      }
    },
  }
}
export const tinfoilAuth = createTinfoilAuth()
