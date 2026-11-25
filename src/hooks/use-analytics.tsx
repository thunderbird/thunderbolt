/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri } from '@/lib/platform'
import { usePostHogClient } from '@/lib/posthog'
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

/**
 * Hook to track page views and page leaves on route changes
 */
export const usePageTracking = () => {
  const location = useLocation()
  const posthog = usePostHogClient()
  const previousUrl = useRef<string | null>(null)
  const origin = isTauri() ? 'tauri://' : window.location.origin
  // Keyed on the URL. A history step that keeps it, such as a closed view popping its entry, still makes a new
  // location, but it is not a new page.
  const fullUrl = origin + location.pathname + location.search

  useEffect(() => {
    if (!posthog) {
      return
    }

    if (previousUrl.current) {
      posthog.capture('$pageleave', { $current_url: previousUrl.current })
    }

    posthog.capture('$pageview', { $current_url: fullUrl })
    previousUrl.current = fullUrl
  }, [fullUrl, posthog])

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
