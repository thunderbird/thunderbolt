import { getSettings } from '@/config/settings'
import {
  addClientSecretIfPresent,
  createTokenRefresher,
  isMobileRedirectUri,
  isMobileRequest,
} from '@/utils/oauth-utils'
import { Elysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const createGoogleAuthRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/auth/google' })
    .get('/config', async ({ request }) => {
      const settings = getSettings()
      const isMobile = isMobileRequest(request)

      // Check platform query param for iOS vs Android
      const url = request ? new URL(request.url) : null
      const platform = url?.searchParams.get('platform')
      const isIos = platform === 'ios'
      const isAndroid = platform === 'android' || platform === 'mobile'

      // Select appropriate client ID based on platform
      const clientId =
        isIos && settings.googleClientIdIos
          ? settings.googleClientIdIos
          : isAndroid && settings.googleClientIdAndroid
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

        const isMobile = isMobileRedirectUri(validatedBody.redirect_uri)

        const clientId =
          isMobile && settings.googleClientIdAndroid ? settings.googleClientIdAndroid : settings.googleClientId
        const clientSecret = isMobile ? '' : settings.googleClientSecret

        if (!clientId) {
          set.status = 503
          return {
            error: `Google OAuth not configured for ${isMobile ? 'Android' : 'web/desktop'}. Set GOOGLE_CLIENT_ID${isMobile ? '_ANDROID' : ''}.`,
          }
        }

        if (!isMobile && !clientSecret) {
          set.status = 503
          return {
            error: 'Google OAuth not configured for web/desktop. Set GOOGLE_CLIENT_SECRET.',
          }
        }

        console.info(`Google OAuth token exchange for ${isMobile ? 'Android (installed app)' : 'web/desktop'}`)

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

        const hasWebCredentials = settings.googleClientId && settings.googleClientSecret
        const hasAndroidCredentials = settings.googleClientIdAndroid
        const hasIosCredentials = settings.googleClientIdIos

        if (!hasWebCredentials && !hasAndroidCredentials && !hasIosCredentials) {
          set.status = 503
          return {
            error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
          }
        }

        const tryRefresh = createTokenRefresher(GOOGLE_TOKEN_URL, fetchFn)

        let response = await tryRefresh(
          settings.googleClientId,
          settings.googleClientSecret,
          validatedBody.refresh_token,
        )

        if (!response && settings.googleClientIdAndroid) {
          response = await tryRefresh(
            settings.googleClientIdAndroid,
            '', // Android: No client secret (PKCE flow)
            validatedBody.refresh_token,
          )
        }

        if (!response && settings.googleClientIdIos) {
          response = await tryRefresh(
            settings.googleClientIdIos,
            '', // iOS: No client secret (PKCE flow)
            validatedBody.refresh_token,
          )
        }

        if (!response) {
          set.status = 400
          return {
            error: 'Failed to refresh token. The refresh token may be invalid or expired.',
          }
        }

        // Process the successful response
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
        }),
      },
    )
}
