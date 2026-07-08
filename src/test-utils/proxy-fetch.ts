/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { FetchFn } from '@/lib/proxy-fetch'

/**
 * A no-op `FetchFn` for tests. Every call resolves to an empty `Response` and
 * `preconnect` resolves to `true`, satisfying the full `FetchFn` shape so
 * consumers don't need a `as unknown as FetchFn` cast.
 */
export const mockProxyFetch: FetchFn = Object.assign(async () => new Response(), {
  preconnect: async () => true,
})
