import { getSettings } from '@/config/settings'
import { addClientSecretIfPresent, createTokenRefresher, detectPlatformFromRedirectUri } from '@/utils/oauth-utils'
import { Elysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const createGoogleAuthRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/auth/google' })
    .get('/config', async ({ request }) => {
      const settings = getSettings()

      const url = request ? new URL(request.url) : null
      const platform = url?.searchParams.get('platform')

      const clientId =
        platform === 'ios' && settings.googleClientIdIos
          ? settings.googleClientIdIos
          : platform === 'android' && settings.googleClientIdAndroid
            ? settings.googleClientIdAndroid
            : settings.googleClientId

      return {
        client_id: clientId,
      }
    })

    .post(
      '/exchange',
      async ({ body, set }) => {
        const settings = getSettings()
        const validatedBody = codeRequestSchema.parse(body)

        const platform = detectPlatformFromRedirectUri(
          validatedBody.redirect_uri,
          settings.googleClientIdIos,
          settings.googleClientIdAndroid,
        )

        let clientId = settings.googleClientId
        if (platform === 'ios' && settings.googleClientIdIos) {
          clientId = settings.googleClientIdIos
        } else if (platform === 'android' && settings.googleClientIdAndroid) {
          clientId = settings.googleClientIdAndroid
        }

        const clientSecret = platform ? '' : settings.googleClientSecret

        if (!clientId) {
          set.status = 503
          return {
            error: `Google OAuth not configured for ${platform || 'web/desktop'}. Set GOOGLE_CLIENT_ID${platform === 'ios' ? '_IOS' : platform === 'android' ? '_ANDROID' : ''}.`,
          }
        }

        if (!platform && !clientSecret) {
          set.status = 503
          return {
            error: 'Google OAuth not configured for web/desktop. Set GOOGLE_CLIENT_SECRET.',
          }
        }

        console.info(`Google OAuth token exchange for ${platform ? `${platform} (installed app)` : 'web/desktop'}`)

        const data = new URLSearchParams({
          code: validatedBody.code,
          client_id: clientId,
          redirect_uri: validatedBody.redirect_uri,
          grant_type: 'authorization_code',
          code_verifier: validatedBody.code_verifier,
        })

        addClientSecretIfPresent(data, clientSecret)

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
        const validatedBody = refreshRequestSchema.parse(body)

        const platform = validatedBody.platform

        // Select credentials based on platform
        const clientId =
          platform === 'ios' && settings.googleClientIdIos
            ? settings.googleClientIdIos
            : platform === 'android' && settings.googleClientIdAndroid
              ? settings.googleClientIdAndroid
              : settings.googleClientId

        const clientSecret = platform ? '' : settings.googleClientSecret

        if (!clientId) {
          set.status = 503
          return {
            error: `Google OAuth not configured for ${platform || 'web/desktop'}. Set GOOGLE_CLIENT_ID${platform === 'ios' ? '_IOS' : platform === 'android' ? '_ANDROID' : ''}.`,
          }
        }

        if (!platform && !clientSecret) {
          set.status = 503
          return {
            error: 'Google OAuth not configured for web/desktop. Set GOOGLE_CLIENT_SECRET.',
          }
        }

        const tryRefresh = createTokenRefresher(GOOGLE_TOKEN_URL, fetchFn)

        const response = await tryRefresh(clientId, clientSecret, validatedBody.refresh_token)

        if (!response) {
          set.status = 400
          return {
            error: 'Failed to refresh token. The refresh token may be invalid or expired.',
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
      },
      {
        body: t.Object({
          refresh_token: t.String(),
          platform: t.Optional(t.Union([t.Literal('ios'), t.Literal('android')])),
        }),
      },
    )
}
