import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
// Must match scopes requested by the frontend (see integrations/microsoft/auth.ts)
const SCOPES = 'https://graph.microsoft.com/mail.read User.Read offline_access'

/**
 * Microsoft OAuth confidential client proxy — keeps the client secret server-side
 * so the Tauri frontend doesn't need to embed it.
 */
export const createMicrosoftAuthRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/auth/microsoft' })
    .onError(safeErrorHandler)
    .get('/config', async () => {
      const settings = getSettings()

      return {
        client_id: settings.microsoftClientId,
        configured: Boolean(settings.microsoftClientId && settings.microsoftClientSecret),
      }
    })

    .post(
      '/exchange',
      async ({ body, set }) => {
        const settings = getSettings()

        if (!settings.microsoftClientId || !settings.microsoftClientSecret) {
          set.status = 503
          return {
            error: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
          }
        }

        const validatedBody = codeRequestSchema.parse(body)

        const data = new URLSearchParams({
          client_id: settings.microsoftClientId,
          client_secret: settings.microsoftClientSecret,
          code: validatedBody.code,
          redirect_uri: validatedBody.redirect_uri,
          grant_type: 'authorization_code',
          code_verifier: validatedBody.code_verifier,
          scope: SCOPES,
        })

        try {
          const response = await fetchFn(MICROSOFT_TOKEN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: data,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            const errorMsg = errorData.error_description || `HTTP ${response.status}`
            console.error('Microsoft token exchange failed:', errorMsg)

            set.status = 400
            return {
              error: `Token exchange failed: ${errorMsg}`,
            }
          }

          const tokenData = await response.json()
          console.info('Successfully exchanged Microsoft OAuth code for tokens')

          const result: OAuthTokenResponse = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || null,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type,
            scope: tokenData.scope || null,
          }

          return result
        } catch (error) {
          console.error('Unexpected error during Microsoft token exchange:', error)
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

        if (!settings.microsoftClientId || !settings.microsoftClientSecret) {
          set.status = 503
          return {
            error: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
          }
        }

        const validatedBody = refreshRequestSchema.parse(body)

        const data = new URLSearchParams({
          client_id: settings.microsoftClientId,
          client_secret: settings.microsoftClientSecret,
          refresh_token: validatedBody.refresh_token,
          grant_type: 'refresh_token',
          scope: SCOPES,
        })

        try {
          const response = await fetchFn(MICROSOFT_TOKEN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: data,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            const errorMsg = errorData.error_description || `HTTP ${response.status}`
            console.error('Microsoft token refresh failed:', errorMsg)

            set.status = 400
            return {
              error: `Token refresh failed: ${errorMsg}`,
            }
          }

          const tokenData = await response.json()
          console.info('Successfully refreshed Microsoft OAuth token')

          const result: OAuthTokenResponse = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || validatedBody.refresh_token,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type,
            scope: tokenData.scope || null,
          }

          return result
        } catch (error) {
          console.error('Unexpected error during Microsoft token refresh:', error)
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
