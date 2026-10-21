/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useEffect, useEffectEvent, useState } from 'react'
import { http } from '@/lib/http'
import { setAuthToken } from '@/lib/auth-token'
import { isSafeUrl, normalizeBackendUrl } from '@/lib/url-utils'
import { isTauri } from '@/lib/platform'
import { SsoCallbackError, startSsoFlowLoopback } from '@/lib/sso-loopback'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useAnonymousPromotionAnalytics } from '@/lib/analytics/use-anonymous-promotion-analytics'
import { useAuth } from '@/contexts'
import Loading from '@/loading'

/**
 * In SSO mode (OIDC or SAML), redirects unauthenticated users to the backend's
 * SSO sign-in endpoint, which redirects to the identity provider.
 *
 * On Tauri desktop, uses the system browser + loopback server pattern instead
 * of navigating the webview (WKWebView drops cookies during cross-origin redirects).
 */
const SsoRedirect = () => {
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const analytics = useAnonymousPromotionAnalytics()
  const [error, setError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const normalizedCloudUrl = normalizeBackendUrl(cloudUrl)

  const redirectToSso = useEffectEvent(async (signal: AbortSignal) => {
    const baseUrl = normalizedCloudUrl.replace(/\/v1$/, '')
    try {
      // AuthGate already resolved this session on normal entry. Direct visits
      // wait below, so analytics never adds another request before sign-in.
      await analytics.captureAnonId(authClient, session)
      if (signal.aborted) {
        return
      }

      // Tauri desktop: use system browser + loopback server (RFC 8252)
      if (isTauri()) {
        analytics.persistForSso()
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
          json: {
            providerId: 'sso',
            callbackURL: window.location.origin + '/',
            errorCallbackURL: window.location.origin + '/sso-error',
          },
          credentials: 'include',
          signal,
        })
        .json<{ url: string }>()

      if (!isSafeUrl(data.url)) {
        console.error('SSO redirect blocked: unsafe URL', data.url)
        setError(true)
        return
      }

      // Persist the anon id to sessionStorage BEFORE the browser navigates away.
      analytics.persistForSso()
      window.location.href = data.url
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      if (err instanceof SsoCallbackError) {
        window.location.replace(`/sso-error?error=${encodeURIComponent(err.code)}`)
        return
      }
      console.error('SSO redirect failed:', err)
      setError(true)
    }
  })

  useEffect(() => {
    if (isPending) {
      return
    }
    setError(false)
    const abortController = new AbortController()
    void redirectToSso(abortController.signal)

    return () => abortController.abort()
  }, [normalizedCloudUrl, retryKey, isPending])

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[length:var(--font-size-body)] text-muted-foreground">
          <Trans>
            Unable to connect to the identity provider. Check your network connection and SSO configuration.
          </Trans>
        </p>
        <button
          type="button"
          onClick={() => setRetryKey((k) => k + 1)}
          className="h-[var(--touch-height-default)] rounded-lg bg-primary px-4 text-[length:var(--font-size-body)] text-primary-foreground"
        >
          <Trans>Try again</Trans>
        </button>
      </div>
    )
  }

  return <Loading />
}

export default SsoRedirect
