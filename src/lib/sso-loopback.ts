/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Timeout for the user to complete SSO auth in the system browser (5 minutes) */
const ssoTimeoutMs = 5 * 60 * 1000

/** Sentinel used to distinguish timeout rejections from real errors */
const ssoTimeout = Symbol('sso-timeout')

/**
 * Starts an SSO flow using the localhost loopback server and the system browser.
 *
 * This is the Tauri desktop equivalent of the web SSO flow. Instead of navigating
 * the webview to the IdP (which fails due to WKWebView cookie restrictions),
 * we open the system browser and use the backend's desktop-callback endpoint
 * to bridge the session cookie back to the app via the loopback server.
 *
 * @param baseUrl - Backend base URL (e.g. `http://localhost:8000`)
 * @param timeoutMs - How long to wait for the user to complete auth (default: 5 minutes)
 * @returns Signed bearer token on success, `null` on timeout
 * @throws On server start failure, network error, or IdP error
 */
export const startSsoFlowLoopback = async (baseUrl: string, timeoutMs = ssoTimeoutMs): Promise<string | null> => {
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const { openUrl } = await import('@tauri-apps/plugin-opener')

  const port = await invoke<number>('start_oauth_server')

  let unlisten: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    let resolveUrl!: (url: string) => void
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })

    // Register listener BEFORE opening browser to avoid race condition
    unlisten = await listen<{ url: string }>('oauth-callback', (event) => {
      resolveUrl(event.payload.url)
    })

    // Open the system browser to the backend's desktop-initiate endpoint.
    // This endpoint calls Better Auth's /sign-in/sso internally and redirects
    // to the IdP, ensuring state cookies are set in the system browser context
    // (not the Tauri webview, which drops cross-origin cookies).
    const initiateUrl = `${baseUrl}/v1/api/auth/sso/desktop-initiate?loopback_port=${port}`
    await openUrl(initiateUrl)

    const callbackUrl = await Promise.race([
      urlPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(ssoTimeout), timeoutMs)
      }),
    ])

    const url = new URL(callbackUrl)
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (error) {
      throw new Error(error)
    }

    const token = url.searchParams.get('token')
    if (!token) {
      throw new Error('No token in SSO callback')
    }

    return token
  } catch (err) {
    if (err === ssoTimeout) {
      return null
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    unlisten?.()
  }
}
