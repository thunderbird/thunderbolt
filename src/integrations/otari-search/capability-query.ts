/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { queryClient } from '@/lib/query-client'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import { loadOtariWebCapabilities } from './capabilities'

const capabilityQueryKey = ['otari-web-capabilities'] as const

/**
 * Reuse discovery across settings and turns for thirty seconds. Server capability
 * changes can take that long to appear here; every tool request still enforces live authorization.
 */
export const loadCachedOtariWebCapabilities = async (
  connection: { id: string; url: string; revision?: string },
  apiKey: string,
  signal: AbortSignal,
  client = queryClient,
) => {
  const identity = getIdentitySignal()
  signal.throwIfAborted()
  identity.throwIfAborted()
  // Credentials without a generation cannot safely share capability results.
  if (!connection.revision) {
    return loadOtariWebCapabilities(connection.url, apiKey, AbortSignal.any([signal, identity]))
  }
  const capabilities = await client.fetchQuery({
    queryKey: [...capabilityQueryKey, connection.id, connection.url, connection.revision],
    networkMode: 'always',
    queryFn: ({ signal }) => loadOtariWebCapabilities(connection.url, apiKey, AbortSignal.any([signal, identity])),
    staleTime: (query) => (query.state.data && !Object.values(query.state.data).includes('unknown') ? 30_000 : 0),
    retry: false,
  })
  signal.throwIfAborted()
  identity.throwIfAborted()
  return capabilities
}

/** Retire cached capabilities and pending discovery when leaving the current identity. */
export const clearOtariCapabilityCache = (client = queryClient) =>
  client.removeQueries({ queryKey: capabilityQueryKey })
