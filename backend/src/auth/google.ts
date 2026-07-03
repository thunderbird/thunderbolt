/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings, isOAuthRedirectUriAllowed } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, type AnyElysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const googleTokenUrl = 'https://oauth2.googleapis.com/token'

type OAuthProxyOptions = {
  /**
   * When set, mount an IP rate-limit plugin and DO NOT require a Thunderbolt
   * session — needed so standalone (no-account) integrations can broker OAuth
   * through the public server (spec-standalone §12). The client secret stays
   * server-side and the redirect_uri allowlist + rate limit bound abuse.
   */
  ipRateLimit?: AnyElysia
}

/**
 * Google OAuth confidential client proxy — keeps the client secret server-side
 * so the Tauri frontend doesn't need to embed it. When `ipRateLimit` is passed
 * the routes are unauthenticated (standalone); otherwise a session is required.
 */
export const createGoogleAuthRoutes = (
  auth: Auth,
  fetchFn: typeof fetch = globalThis.fetch,
  options: OAuthProxyOptions = {},
) => {
  const requireAuth = !options.ipRateLimit
  const authGuard = requireAuth ? { auth: true as const } : {}
  const base = new Elysia({ prefix: '/auth/google' }).onError(safeErrorHandler).use(createAuthMacro(auth))
  if (options.ipRateLimit) {
    base.use(options.ipRateLimit)
  }
  return base
    .get(
      '/config',
      async () => {
        const settings = getSettings()

        return {
          client_id: settings.googleClientId,
          configured: Boolean(settings.googleClientId && settings.googleClientSecret),
        }
      },
      { ...authGuard },
    )

    .post(
      '/exchange',
      async ({ body, set }) => {
        const settings = getSettings()

        if (!settings.googleClientId || !settings.googleClientSecret) {
          set.status = 503
          return {
            error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
          }
        }

        const validatedBody = codeRequestSchema.parse(body)

        if (!isOAuthRedirectUriAllowed(validatedBody.redirect_uri, settings)) {
          set.status = 400
          return { error: 'Invalid redirect_uri' }
        }

        const data = new URLSearchParams({
          code: validatedBody.code,
          client_id: settings.googleClientId,
          client_secret: settings.googleClientSecret,
          redirect_uri: validatedBody.redirect_uri,
          grant_type: 'authorization_code',
          code_verifier: validatedBody.code_verifier,
        })

        try {
          const response = await fetchFn(googleTokenUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: data,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            const errorMsg = errorData.error_description || `HTTP ${response.status}`
            console.error('Google token exchange failed:', errorMsg)

            set.status = 400
            return {
              error: `Token exchange failed: ${errorMsg}`,
            }
          }

          const tokenData = await response.json()
          console.info('Successfully exchanged Google OAuth code for tokens')

          const result: OAuthTokenResponse = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || null,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type,
            scope: tokenData.scope || null,
          }

          return result
        } catch (error) {
          console.error('Unexpected error during Google token exchange:', error)
          set.status = 500
          return {
            error: 'Internal server error during token exchange',
          }
        }
      },
      {
        ...authGuard,
        body: t.Object({
          code: t.String(),
          code_verifier: t.String(),
          redirect_uri: t.String(),
        }),
      },
    )

    .post(
      '/refresh',
      async ({ body, set }) => {
        const settings = getSettings()

        if (!settings.googleClientId || !settings.googleClientSecret) {
          set.status = 503
          return {
            error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
          }
        }

        const validatedBody = refreshRequestSchema.parse(body)

        const data = new URLSearchParams({
          refresh_token: validatedBody.refresh_token,
          client_id: settings.googleClientId,
          client_secret: settings.googleClientSecret,
          grant_type: 'refresh_token',
        })

        try {
          const response = await fetchFn(googleTokenUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: data,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            const errorMsg = errorData.error_description || `HTTP ${response.status}`
            console.error('Google token refresh failed:', errorMsg)

            set.status = 400
            return {
              error: `Token refresh failed: ${errorMsg}`,
            }
          }

          const tokenData = await response.json()
          console.info('Successfully refreshed Google OAuth token')

          const result: OAuthTokenResponse = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || validatedBody.refresh_token,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type,
            scope: tokenData.scope || null,
          }

          return result
        } catch (error) {
          console.error('Unexpected error during Google token refresh:', error)
          set.status = 500
          return {
            error: 'Internal server error during token refresh',
          }
        }
      },
      {
        ...authGuard,
        body: t.Object({
          refresh_token: t.String(),
        }),
      },
    )
}
