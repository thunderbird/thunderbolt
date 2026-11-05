/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { generateCodeVerifier } from './pkce'

/** Timeout for the user to complete SSO auth in the system browser (5 minutes) */
const ssoTimeoutMs = 5 * 60 * 1000

/** Sentinel used to distinguish timeout rejections from real errors */
const ssoTimeout = Symbol('sso-timeout')

/** The loopback callback reported a failed login. `code` is the untrusted `error` query value. */
export class SsoCallbackError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

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
 * @throws On server start failure, network error, or `SsoCallbackError` for an IdP error
 */
export const startSsoFlowLoopback = async (baseUrl: string, timeoutMs = ssoTimeoutMs): Promise<string | null> => {
  const flowId = generateCodeVerifier()
  const port = await invoke<number>('start_oauth_server', { flowId })
  const callbackOrigin = `http://localhost:${port}`

  let unlisten: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    let resolveUrl!: (url: string) => void
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })

    // Register listener BEFORE opening browser to avoid race condition
    unlisten = await listen<{ url: string }>('oauth-callback', (event) => {
      const url = URL.canParse(event.payload.url) ? new URL(event.payload.url) : null
      if (url?.origin === callbackOrigin && url.pathname === '/') {
        resolveUrl(url.href)
      }
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
    const error = url.searchParams.get('error')
    if (error) {
      throw new SsoCallbackError(error)
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
    void invoke<void>('stop_oauth_server', { flowId }).catch(console.error)
  }
}
