/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Elysia, t, type AnyElysia, type ErrorHandler } from 'elysia'
import { createAuthMacro, type Auth } from './elysia-plugin'
import { getSettings, isOAuthRedirectUriAllowed, isRequestOriginAllowed } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { oauthTokenResponseSchema } from './types'

type Provider = 'google' | 'microsoft'

/** Sanitizes credential-bearing parse and validation failures before general error logging. */
const sanitizeOAuthRequestError: ErrorHandler = ({ code, set }) => {
  if (code === 'VALIDATION' || code === 'PARSE') {
    set.status = 422
    return { error: 'Invalid OAuth request' }
  }
}

/** A narrow token relay; public access never grants an app session or proxy access. */
export const createIntegrationOAuthRoutes = (
  provider: Provider,
  auth: Auth,
  fetchFn: typeof fetch,
  rateLimit: AnyElysia,
) => {
  const publicAccess = getSettings().integrationOAuthAllowPublic
  const providerConfig = () => {
    const settings = getSettings()
    return {
      clientId: provider === 'google' ? settings.googleClientId : settings.microsoftClientId,
      clientSecret: provider === 'google' ? settings.googleClientSecret : settings.microsoftClientSecret,
      tokenUrl:
        provider === 'google'
          ? `${settings.googleBaseUrl}/token`
          : `${settings.microsoftBaseUrl}/common/oauth2/v2.0/token`,
    }
  }

  const tokenRequest = async (params: Record<string, string>) => {
    const { clientId, clientSecret, tokenUrl } = providerConfig()
    if (!clientId || !clientSecret) {
      return Response.json({ error: 'OAuth provider is not configured' }, { status: 503 })
    }
    try {
      const response = await fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        // Provider error bodies can contain credentials or user data. Never echo or log them.
        if (response.status === 429 || response.status >= 500) {
          return Response.json({ error: 'OAuth provider is unavailable. Try again.' }, { status: 502 })
        }
        return Response.json({ error: 'OAuth authorization failed. Reconnect your account.' }, { status: 400 })
      }
      const tokens = oauthTokenResponseSchema.parse(await response.json())
      return { ...tokens, refresh_token: tokens.refresh_token || params.refresh_token || null }
    } catch {
      return Response.json({ error: 'OAuth provider is unavailable. Try again.' }, { status: 502 })
    }
  }

  return (
    new Elysia({ prefix: `/auth/${provider}` })
      .onError([sanitizeOAuthRequestError, safeErrorHandler])
      .use(createAuthMacro(auth))
      .use(rateLimit)
      // onRequest is hoisted to the whole app; these restrictions belong only to the relay routes.
      .onBeforeHandle(({ request, set }) => {
        set.headers['Cache-Control'] = 'no-store'
        set.headers.Pragma = 'no-cache'
        if (request.headers.has('origin') && !isRequestOriginAllowed(request, getSettings())) {
          return new Response('Forbidden origin', { status: 403 })
        }
        if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
          return new Response('JSON body required', { status: 415 })
        }
      })
      .guard({ auth: !publicAccess }, (app) =>
        app
          .get('/config', () => {
            const { clientId, clientSecret } = providerConfig()
            return { client_id: clientId, configured: Boolean(clientId && clientSecret) }
          })
          .post(
            '/exchange',
            ({ body }) => {
              if (!isOAuthRedirectUriAllowed(body.redirect_uri, getSettings())) {
                return Response.json({ error: 'Invalid redirect_uri' }, { status: 400 })
              }
              return tokenRequest({ ...body, grant_type: 'authorization_code' })
            },
            {
              body: t.Object(
                {
                  code: t.String({ minLength: 1, maxLength: 4096 }),
                  code_verifier: t.String({ pattern: '^[A-Za-z0-9._~-]{43,128}$' }),
                  redirect_uri: t.String({ minLength: 1, maxLength: 2048 }),
                },
                { additionalProperties: false },
              ),
            },
          )
          .post('/refresh', ({ body }) => tokenRequest({ ...body, grant_type: 'refresh_token' }), {
            body: t.Object(
              { refresh_token: t.String({ minLength: 1, maxLength: 16384 }) },
              { additionalProperties: false },
            ),
          }),
      )
  )
}
