/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { useQuery } from '@tanstack/react-query'

/** TanStack Query key — exported so the test provider can pre-populate the cache. */
export const mediaJwtQueryKey = ['media-jwt'] as const

/**
 * Mints (and caches) a short-lived JWT used by the unified `/v1/proxy/*`
 * endpoint when authenticating browser sub-resource loads (`<img src>`,
 * `<link rel="icon">`) that cannot attach an `Authorization` header.
 *
 * The backend issues tokens with a 10 min TTL via a custom POST handler at
 * `/api/auth/token` (POST, not GET — token-issuing endpoints reachable via
 * GET are bookmarkable, prefetchable, and embeddable as `<img src>` which
 * makes them CSRF-burnable). We cache the token for 8 min (2 min buffer
 * before expiry) and rely on TanStack Query for deduplication across
 * components.
 *
 * @returns The current JWT, or `null` while the first mint is in flight.
 *          Callers passing `null` to the proxy URL helper should render a
 *          fallback (skeleton or letter badge) until the token resolves.
 */
export const useMediaJwt = (): string | null => {
  const httpClient = useHttpClient()
  const { data } = useQuery({
    queryKey: mediaJwtQueryKey,
    queryFn: async () => {
      const res = await httpClient.post('api/auth/token').json<{ token: string }>()
      return res.token
    },
    // Token TTL on the backend is 10 min. 8 min staleTime + 1 retry leaves a
    // 2-min headroom that absorbs network jitter without serving an expired
    // token to the proxy.
    staleTime: 8 * 60 * 1000,
    retry: 1,
  })
  return data ?? null
}
