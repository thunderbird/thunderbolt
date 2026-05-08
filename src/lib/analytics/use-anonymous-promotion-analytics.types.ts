/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'

/** Analytics interface for the anonymous → identified user promotion flow. Published by M8. */
export type AnonymousPromotionAnalytics = {
  /** Capture the current anonymous user id BEFORE OTP sign-in so we can alias later. */
  captureAnonId: (authClient: AuthClient) => Promise<void>
  /** Persist anonymous id across SSO redirects (called before redirect). */
  persistForSso: () => void
  /** Fire the PostHog alias that links the anonymous id to the new authenticated user id. */
  onPromotionSuccess: (newUserId: string) => void
}
