/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri } from '@/lib/platform'
import { usePostHog } from 'posthog-js/react'
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

/**
 * Hook to track page views and page leaves on route changes
 */
export const usePageTracking = () => {
  const location = useLocation()
  const posthog = usePostHog()
  const previousUrl = useRef<string | null>(null)

  useEffect(() => {
    if (!posthog) {
      return
    }

    const origin = isTauri() ? 'tauri://' : window.location.origin
    const fullUrl = origin + location.pathname + location.search

    if (previousUrl.current) {
      posthog.capture('$pageleave', { $current_url: previousUrl.current })
    }

    posthog.capture('$pageview', { $current_url: fullUrl })
    previousUrl.current = fullUrl
  }, [location, posthog])

  // Track page leave when component unmounts (app closing)
  useEffect(() => {
    return () => {
      if (!posthog || !previousUrl.current) {
        return
      }
      posthog.capture('$pageleave', { $current_url: previousUrl.current })
    }
  }, [posthog])
}
