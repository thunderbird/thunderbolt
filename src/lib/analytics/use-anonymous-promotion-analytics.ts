/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnonymousPromotionAnalytics } from './use-anonymous-promotion-analytics.types'

// TODO: M8 will replace this stub at integration.
export const useAnonymousPromotionAnalytics = (): AnonymousPromotionAnalytics => ({
  captureAnonId: async () => {},
  persistForSso: () => {},
  onPromotionSuccess: () => {},
})
