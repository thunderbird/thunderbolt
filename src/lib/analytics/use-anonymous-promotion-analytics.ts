/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import posthog from 'posthog-js'
import { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import type { AuthClient } from '@/contexts'

export type AnonymousPromotionAnalytics = {
  /** Read the current session via `authClient.getSession()`; capture the user.id if isAnonymous === true. Idempotent. */
  captureAnonId: (authClient: AuthClient) => Promise<void>
  /** Persist captured anon id to sessionStorage for cross-redirect retrieval (used by SSO flow). Call BEFORE any redirect. */
  persistForSso: () => void
  /** Fire posthog.alias(newUserId, capturedAnonId). Also fires the 'anonymous_user_promoted' event. Safe to call when no anon id was captured (no-op). */
  onPromotionSuccess: (newUserId: string) => void
}

// Module-private sessionStorage key shared with the SSO bridge.
export const pendingAnonIdKey = 'thunderbolt_pending_anon_id'

// Default posthog alias helper — the ONLY production site allowed to call alias.
// If the client was never initialized (self-hosted, no key), alias() is a silent
// no-op because posthog-js handles uninitialized state.
const defaultAlias = (newUserId: string, anonId: string) => {
  posthog.alias(newUserId, anonId)
}

/**
 * Create the promotion analytics state machine bound to an external mutable ref.
 * Extracted so the pure logic can be unit-tested without a React renderer.
 *
 * `trackEvent` and `alias` are injected (defaulting to the real posthog implementations)
 * so tests can pass fakes without module mocking.
 */
export const createAnonymousPromotionAnalytics = (
  capturedIdRef: { current: string | null },
  trackEvent: typeof defaultTrackEvent = defaultTrackEvent,
  alias: (newUserId: string, anonId: string) => void = defaultAlias,
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
    sessionStorage.setItem(pendingAnonIdKey, anonId)
  },

  onPromotionSuccess: (newUserId: string) => {
    const anonId = capturedIdRef.current
    if (!anonId || newUserId === anonId) {
      return
    }

    // Order: alias BEFORE any navigate. PostHog queues requests to localStorage so the event
    // will replay even if the page unloads before the network request completes.
    alias(newUserId, anonId)
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
  return createAnonymousPromotionAnalytics(capturedIdRef)
}
