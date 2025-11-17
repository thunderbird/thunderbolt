import { getSettings } from '@/config/settings'
import { addClientSecretIfPresent, createTokenRefresher, detectPlatformFromRedirectUri } from '@/utils/oauth-utils'
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

      const url = request ? new URL(request.url) : null
      const platform = url?.searchParams.get('platform')
      const isMobile = platform === 'ios' || platform === 'android'

      const clientId =
        platform === 'ios' && settings.microsoftClientIdIos
          ? settings.microsoftClientIdIos
          : platform === 'android' && settings.microsoftClientIdAndroid
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

        const platform = detectPlatformFromRedirectUri(
          validatedBody.redirect_uri,
          settings.microsoftClientIdIos,
          settings.microsoftClientIdAndroid,
        )

        let clientId = settings.microsoftClientId
        if (platform === 'ios' && settings.microsoftClientIdIos) {
          clientId = settings.microsoftClientIdIos
        } else if (platform === 'android' && settings.microsoftClientIdAndroid) {
          clientId = settings.microsoftClientIdAndroid
        }

        const clientSecret = platform ? '' : settings.microsoftClientSecret

        if (!clientId) {
          set.status = 503
          return {
            error: `Microsoft OAuth not configured for ${platform || 'web/desktop'}. Set MICROSOFT_CLIENT_ID${platform === 'ios' ? '_IOS' : platform === 'android' ? '_ANDROID' : ''}.`,
          }
        }

        if (!platform && !clientSecret) {
          set.status = 503
          return {
            error: 'Microsoft OAuth not configured for web/desktop. Set MICROSOFT_CLIENT_SECRET.',
          }
        }

        console.info(`Microsoft OAuth token exchange for ${platform ? `${platform} (mobile app)` : 'web/desktop'}`)

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

        const platform = validatedBody.platform

        // Select credentials based on platform
        const clientId =
          platform === 'ios' && settings.microsoftClientIdIos
            ? settings.microsoftClientIdIos
            : platform === 'android' && settings.microsoftClientIdAndroid
              ? settings.microsoftClientIdAndroid
              : settings.microsoftClientId

        const clientSecret = platform ? '' : settings.microsoftClientSecret

        if (!clientId) {
          set.status = 503
          return {
            error: `Microsoft OAuth not configured for ${platform || 'web/desktop'}. Set MICROSOFT_CLIENT_ID${platform === 'ios' ? '_IOS' : platform === 'android' ? '_ANDROID' : ''}.`,
          }
        }

        if (!platform && !clientSecret) {
          set.status = 503
          return {
            error: 'Microsoft OAuth not configured for web/desktop. Set MICROSOFT_CLIENT_SECRET.',
          }
        }

        const tryRefresh = createTokenRefresher(MICROSOFT_TOKEN_URL, fetchFn)

        const response = await tryRefresh(clientId, clientSecret, validatedBody.refresh_token, { scope: SCOPES })

        if (!response) {
          set.status = 400
          return {
            error: 'Failed to refresh token. The refresh token may be invalid or expired.',
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
      },
      {
        body: t.Object({
          refresh_token: t.String(),
          platform: t.Optional(t.Union([t.Literal('ios'), t.Literal('android')])),
        }),
      },
    )
}
