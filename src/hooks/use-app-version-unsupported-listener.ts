/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { useConfigStore } from '@/api/config-store'
import { appVersionUnsupported } from '@/lib/app-version-unsupported'

/**
 * Listens for {@link appVersionUnsupported} (dispatched when OUR backend rejects
 * this build with HTTP 426) and flips the config store's transient
 * `forceUpgrade` flag so `App` renders the upgrade blocker for the rest of the
 * session. Mount high in `App`, before the render gate.
 */
export const useAppVersionUnsupportedListener = () => {
  const setForceUpgrade = useConfigStore((state) => state.setForceUpgrade)
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ minAppVersion?: string }>).detail
      setForceUpgrade(detail?.minAppVersion)
    }
    window.addEventListener(appVersionUnsupported, handler)
    return () => window.removeEventListener(appVersionUnsupported, handler)
  }, [setForceUpgrade])
}
