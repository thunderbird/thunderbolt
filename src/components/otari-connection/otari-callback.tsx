/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import Loading from '@/loading'
import { ProviderAuthorizationResult } from '@/components/provider-authorization-result'
import { captureOtariBrowserReturn, getOtariBrowserReturn } from '@/lib/otari-browser-auth'

/** Consume the tab's PKCE request and resume setup without putting credentials in router history. */
export const OtariCallback = () => {
  const [callbackUrl] = useState(() => new URL(window.location.href))
  const [destination, setDestination] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname)
    const result = callbackUrl.search ? captureOtariBrowserReturn(callbackUrl) : getOtariBrowserReturn()
    setDestination(result?.returnTo ?? null)
  }, [callbackUrl])

  if (destination === undefined) {
    return <Loading />
  }
  if (!destination) {
    return <ProviderAuthorizationResult />
  }
  return (
    <Navigate
      to={destination}
      replace
      state={{
        connectionOAuthReturn:
          getOtariBrowserReturn()?.context === 'connections' ? getOtariBrowserReturn()?.id : undefined,
      }}
    />
  )
}
