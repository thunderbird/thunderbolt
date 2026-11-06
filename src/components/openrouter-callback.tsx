/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { ProviderAuthorizationResult } from '@/components/provider-authorization-result'
import { captureProviderBrowserReturn, getProviderBrowserReturn } from '@/lib/provider-browser-auth'
import Loading from '@/loading'

/** Consume the tab's PKCE return and resume setup without closing or opening a window. */
const OpenRouterCallback = () => {
  const [url] = useState(() => new URL(window.location.href))
  const [destination, setDestination] = useState<string | null | undefined>()
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
    const result = url.search ? captureProviderBrowserReturn(url) : getProviderBrowserReturn()
    setDestination(result?.returnTo ?? null)
  }, [url])
  if (destination === undefined) {
    return <Loading />
  }
  if (destination) {
    return <Navigate to={destination} replace />
  }
  return <ProviderAuthorizationResult status="invalid" sameTab />
}

export default OpenRouterCallback
