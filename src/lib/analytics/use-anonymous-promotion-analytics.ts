/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import posthog from 'posthog-js'
import { trackEvent } from '@/lib/posthog'
import type { AnonymousPromotionAnalytics } from './use-anonymous-promotion-analytics.types'
import type { AuthClient } from '@/contexts'

// Module-private sessionStorage key shared with the SSO bridge.
export const PENDING_ANON_ID_KEY = 'thunderbolt_pending_anon_id'

// Module-private posthog alias helper — the ONLY site in the codebase allowed to call alias.
// Uses top-level import; posthog-js is in the project. If the client was never initialized
// (self-hosted, no key), alias() is a silent no-op because posthog-js handles uninitialized state.
const fireAlias = (newUserId: string, anonId: string) => {
  try {
    posthog.alias(newUserId, anonId)
  } catch {
    // posthog not initialized — silent no-op.
  }
}

/**
 * Create the promotion analytics state machine bound to an external mutable ref.
 * Extracted so the pure logic can be unit-tested without a React renderer.
 */
export const createAnonymousPromotionAnalytics = (
  capturedIdRef: { current: string | null },
): AnonymousPromotionAnalytics => ({
  captureAnonId: async (authClient: AuthClient) => {
    const { data } = await authClient.getSession()
    if (data?.user?.isAnonymous === true) {
      capturedIdRef.current = data.user.id
    }
  },

  persistForSso: () => {
    const anonId = capturedIdRef.current
    if (!anonId) {
      return
    }
    sessionStorage.setItem(PENDING_ANON_ID_KEY, anonId)
  },

  onPromotionSuccess: (newUserId: string) => {
    const anonId = capturedIdRef.current
    if (!anonId || newUserId === anonId) {
      return
    }

    // Order: alias BEFORE any navigate (external-7). PostHog queues requests to localStorage
    // so the event will replay even if the page unloads before the network request completes.
    fireAlias(newUserId, anonId)
    trackEvent('anonymous_user_promoted')

    capturedIdRef.current = null
  },
})

/**
 * Returns three coordinated analytics helpers for the anonymous-user promotion flow.
 *
 * Usage pattern:
 *   1. `captureAnonId(authClient)` — call when the anonymous session is established.
 *   2. `persistForSso()` — call BEFORE any SSO redirect so the id survives the page navigation.
 *   3. `onPromotionSuccess(newUserId)` — call after OTP/SSO sign-in succeeds with the new user id.
 *
 * The hook is idempotent: calling captureAnonId multiple times with the same anonymous session
 * stores the same id. React StrictMode's double-mount results in the same outcome.
 */
export const useAnonymousPromotionAnalytics = (): AnonymousPromotionAnalytics => {
  const capturedIdRef = useRef<string | null>(null)
  // Return a stable object — the functions close over the ref, not state, so re-renders
  // don't create new function identities that would bust memoized children.
  const analyticsRef = useRef<AnonymousPromotionAnalytics | null>(null)
  if (!analyticsRef.current) {
    analyticsRef.current = createAnonymousPromotionAnalytics(capturedIdRef)
  }
  return analyticsRef.current
}
