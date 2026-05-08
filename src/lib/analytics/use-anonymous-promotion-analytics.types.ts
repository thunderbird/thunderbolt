/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'

export type AnonymousPromotionAnalytics = {
  /** Read the current session via `authClient.getSession()`; capture the user.id if isAnonymous === true. Idempotent. */
  captureAnonId: (authClient: AuthClient) => Promise<void>
  /** Persist captured anon id to sessionStorage for cross-redirect retrieval (used by SSO flow). Call BEFORE any redirect. */
  persistForSso: () => void
  /** Fire posthog.alias(newUserId, capturedAnonId). Also fires the 'anonymous_user_promoted' event. Safe to call when no anon id was captured (no-op). */
  onPromotionSuccess: (newUserId: string) => void
}
