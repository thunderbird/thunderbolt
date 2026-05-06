/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { http } from '@/lib/http'
import { setAuthToken } from '@/lib/auth-token'
import { isSafeUrl } from '@/lib/url-utils'
import { isTauri } from '@/lib/platform'
import { startSsoFlowLoopback } from '@/lib/sso-loopback'
import { useSettings } from '@/hooks/use-settings'
import Loading from '@/loading'

/**
 * In SSO mode (OIDC or SAML), redirects unauthenticated users to the backend's
 * SSO sign-in endpoint, which redirects to the identity provider.
 *
 * On Tauri desktop, uses the system browser + loopback server pattern instead
 * of navigating the webview (WKWebView drops cookies during cross-origin redirects).
 */
const SsoRedirect = () => {
  const { cloudUrl } = useSettings({ cloud_url: String })
  const [error, setError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (cloudUrl.isLoading || !cloudUrl.value) {
      return
    }

    setError(false)
    const abortController = new AbortController()
    const baseUrl = cloudUrl.value.replace(/\/v1$/, '')

    const redirectToSso = async () => {
      try {
        // Tauri desktop: use system browser + loopback server (RFC 8252)
        if (isTauri()) {
          const token = await startSsoFlowLoopback(baseUrl)
          if (token) {
            setAuthToken(token)
            window.location.replace('/')
          } else {
            setError(true) // timeout
          }
          return
        }

        // Web: redirect the browser to the IdP
        const data = await http
          .post(`${baseUrl}/v1/api/auth/sign-in/sso`, {
            json: { providerId: 'sso', callbackURL: window.location.origin + '/' },
            credentials: 'include',
            signal: abortController.signal,
          })
          .json<{ url: string }>()

        if (!isSafeUrl(data.url)) {
          console.error('SSO redirect blocked: unsafe URL', data.url)
          setError(true)
          return
        }

        window.location.href = data.url
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        console.error('SSO redirect failed:', err)
        setError(true)
      }
    }

    redirectToSso()

    return () => abortController.abort()
  }, [cloudUrl.isLoading, cloudUrl.value, retryKey])

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[length:var(--font-size-body)] text-muted-foreground">
          Unable to connect to the identity provider. Check your network connection and SSO configuration.
        </p>
        <button
          type="button"
          onClick={() => setRetryKey((k) => k + 1)}
          className="h-[var(--touch-height-default)] rounded-lg bg-primary px-4 text-[length:var(--font-size-body)] text-primary-foreground"
        >
          Try again
        </button>
      </div>
    )
  }

  return <Loading />
}

export default SsoRedirect
