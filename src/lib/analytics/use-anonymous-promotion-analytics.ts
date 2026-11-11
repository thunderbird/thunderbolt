/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import type { AuthClient } from '@/contexts'

type SessionSnapshot = { user: { isAnonymous?: boolean | null } } | null

export type AnonymousPromotionAnalytics = {
  captureAnonymousSession: (authClient: AuthClient, session?: SessionSnapshot) => Promise<void>
  persistForSso: () => void
  onPromotionSuccess: () => void
}

export const pendingPromotionKey = 'thunderbolt_pending_anonymous_promotion'

/** Record conversion counts without retaining or transmitting either account's identity. */
export const createAnonymousPromotionAnalytics = (
  wasAnonymous: { current: boolean },
  trackEvent: typeof defaultTrackEvent = defaultTrackEvent,
): AnonymousPromotionAnalytics => ({
  captureAnonymousSession: async (authClient, session) => {
    wasAnonymous.current = false
    try {
      const data = session === undefined ? (await authClient.getSession()).data : session
      wasAnonymous.current = data?.user.isAnonymous === true
    } catch {
      // Conversion measurement must never prevent the real sign-in attempt.
      console.warn('Could not read the anonymous session for usage analytics')
    }
  },
  persistForSso: () => {
    if (wasAnonymous.current) {
      sessionStorage.setItem(pendingPromotionKey, '1')
    } else {
      sessionStorage.removeItem(pendingPromotionKey)
    }
  },
  onPromotionSuccess: () => {
    if (!wasAnonymous.current) {
      return
    }
    wasAnonymous.current = false
    trackEvent('anonymous_user_promoted')
  },
})

/** Keep only the pre-sign-in anonymous status; analytics never receives an account ID. */
export const useAnonymousPromotionAnalytics = (): AnonymousPromotionAnalytics => {
  const wasAnonymous = useRef(false)
  return createAnonymousPromotionAnalytics(wasAnonymous)
}
