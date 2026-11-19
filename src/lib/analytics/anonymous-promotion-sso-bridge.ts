/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import { pendingPromotionKey } from './use-anonymous-promotion-analytics'
import type { AuthClient } from '@/contexts'

/** Consume a one-use conversion marker after SSO without linking analytics to the account. */
export const consumePendingSsoPromotion = async (
  authClient: AuthClient,
  trackEvent: typeof defaultTrackEvent = defaultTrackEvent,
): Promise<void> => {
  // Older builds persisted an account ID here for aliasing. Never reuse it.
  sessionStorage.removeItem('thunderbolt_pending_anon_id')
  if (sessionStorage.getItem(pendingPromotionKey) !== '1') {
    return
  }
  sessionStorage.removeItem(pendingPromotionKey)
  const { data } = await authClient.getSession()
  if (data?.user && data.user.isAnonymous !== true) {
    trackEvent('anonymous_user_promoted')
  }
}
