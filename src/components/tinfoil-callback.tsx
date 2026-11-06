/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Navigate } from 'react-router'
import { getTinfoilMobileReturn } from '@/lib/tinfoil-mobile-auth'
import { isMobile, isTauri } from '@/lib/platform'
import OpenRouterCallback from './openrouter-callback'

/** Remount the original setup surface after a native app link or same-tab browser return. */
const TinfoilCallback = () => {
  const returned = isTauri() && isMobile() ? getTinfoilMobileReturn() : null
  return returned ? (
    <Navigate
      to={returned.returnTo}
      replace
      state={{ connectionOAuthReturn: returned.context === 'connections' ? returned.id : undefined }}
    />
  ) : (
    <OpenRouterCallback />
  )
}

export default TinfoilCallback
