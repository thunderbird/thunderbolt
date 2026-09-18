/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ApiKeyAuth } from '@earendil-works/pi-ai'

/** Auth resolver for a provider whose credential is already bound by the app. */
export const boundApiKeyAuth = (name: string, apiKey: string): ApiKeyAuth => ({
  name,
  resolve: async () => ({ auth: { apiKey }, source: 'application' }),
})
