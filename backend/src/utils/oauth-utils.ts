/**
 * Shared OAuth utility functions for backend auth routes
 */

/**
 * Detects if redirect URI indicates a mobile request
 * Mobile OAuth uses custom URI schemes (thunderbolt://, msal*, com.googleusercontent.apps.*)
 */
export const isMobileRedirectUri = (redirectUri: string): boolean => {
  return (
    redirectUri.startsWith('thunderbolt://') ||
    redirectUri.startsWith('msal') ||
    redirectUri.startsWith('com.googleusercontent.apps.')
  )
}

/**
 * Adds client_secret to URLSearchParams only if it exists and is not empty
 */
export const addClientSecretIfPresent = (data: URLSearchParams, clientSecret: string): void => {
  if (clientSecret && clientSecret.trim().length > 0) {
    data.set('client_secret', clientSecret)
  }
}

/**
 * Creates a token refresh attempt function
 */
export const createTokenRefresher = (tokenUrl: string, fetchFn: typeof fetch) => {
  return async (
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    additionalParams?: Record<string, string>,
  ): Promise<Response | null> => {
    if (!clientId) return null

    const data = new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      ...additionalParams,
    })

    addClientSecretIfPresent(data, clientSecret)

    try {
      const response = await fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data,
      })
      return response.ok ? response : null
    } catch {
      return null
    }
  }
}
