import { getSettings } from '@/config/settings'
import {
  addClientSecretIfPresent,
  createTokenRefresher,
  isMobileRedirectUri,
  isMobileRequest,
} from '@/utils/oauth-utils'
import { Elysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const SCOPES = 'https://graph.microsoft.com/mail.read User.Read offline_access'

/**
 * Create Microsoft OAuth router
 */
export const createMicrosoftAuthRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/auth/microsoft' })
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
        isIos && settings.microsoftClientIdIos
          ? settings.microsoftClientIdIos
          : isAndroid && settings.microsoftClientIdAndroid
            ? settings.microsoftClientIdAndroid
            : settings.microsoftClientId

      return {
        client_id: clientId,
        configured: Boolean(clientId && (isMobile || settings.microsoftClientSecret)),
      }
    })

    .post(
      '/exchange',
      async ({ body, set }) => {
        const settings = getSettings()
        const validatedBody = codeRequestSchema.parse(body)

        const isMobile = isMobileRedirectUri(validatedBody.redirect_uri)

        const clientId =
          isMobile && settings.microsoftClientIdAndroid ? settings.microsoftClientIdAndroid : settings.microsoftClientId
        const clientSecret = isMobile ? '' : settings.microsoftClientSecret

        if (!clientId) {
          set.status = 503
          return {
            error: `Microsoft OAuth not configured for ${isMobile ? 'Android' : 'web/desktop'}. Set MICROSOFT_CLIENT_ID${isMobile ? '_ANDROID' : ''}.`,
          }
        }

        if (!isMobile && !clientSecret) {
          set.status = 503
          return {
            error: 'Microsoft OAuth not configured for web/desktop. Set MICROSOFT_CLIENT_SECRET.',
          }
        }

        console.info(`Microsoft OAuth token exchange for ${isMobile ? 'Android/iOS (mobile app)' : 'web/desktop'}`)

        const data = new URLSearchParams({
          client_id: clientId,
          code: validatedBody.code,
          redirect_uri: validatedBody.redirect_uri,
          grant_type: 'authorization_code',
          code_verifier: validatedBody.code_verifier,
          scope: SCOPES,
        })

        addClientSecretIfPresent(data, clientSecret)

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
        const validatedBody = refreshRequestSchema.parse(body)

        const hasWebCredentials = settings.microsoftClientId && settings.microsoftClientSecret
        const hasAndroidCredentials = settings.microsoftClientIdAndroid
        const hasIosCredentials = settings.microsoftClientIdIos

        if (!hasWebCredentials && !hasAndroidCredentials && !hasIosCredentials) {
          set.status = 503
          return {
            error: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
          }
        }

        const tryRefresh = createTokenRefresher(MICROSOFT_TOKEN_URL, fetchFn)

        let response = await tryRefresh(
          settings.microsoftClientId,
          settings.microsoftClientSecret,
          validatedBody.refresh_token,
          { scope: SCOPES },
        )

        if (!response && settings.microsoftClientIdAndroid) {
          response = await tryRefresh(
            settings.microsoftClientIdAndroid,
            '', // Android: No client secret (MSAL PKCE flow)
            validatedBody.refresh_token,
            { scope: SCOPES },
          )
        }

        if (!response && settings.microsoftClientIdIos) {
          response = await tryRefresh(
            settings.microsoftClientIdIos,
            '', // iOS: No client secret (MSAL PKCE flow)
            validatedBody.refresh_token,
            { scope: SCOPES },
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
        console.info('Successfully refreshed Microsoft OAuth token')

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
