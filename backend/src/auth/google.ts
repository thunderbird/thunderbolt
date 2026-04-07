import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Google OAuth confidential client proxy — keeps the client secret server-side
 * so the Tauri frontend doesn't need to embed it.
 */
export const createGoogleAuthRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/auth/google' })
    .onError(safeErrorHandler)
    .get('/config', async () => {
      const settings = getSettings()

      return {
        client_id: settings.googleClientId,
      }
    })

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

        const data = new URLSearchParams({
          code: validatedBody.code,
          client_id: settings.googleClientId,
          client_secret: settings.googleClientSecret,
          redirect_uri: validatedBody.redirect_uri,
          grant_type: 'authorization_code',
          code_verifier: validatedBody.code_verifier,
        })

        try {
          const response = await fetchFn(GOOGLE_TOKEN_URL, {
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
          const response = await fetchFn(GOOGLE_TOKEN_URL, {
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
        body: t.Object({
          refresh_token: t.String(),
        }),
      },
    )
}
