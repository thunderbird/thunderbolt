/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { resolveProviderConnection } from '@/dal/provider-connections'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'

/** Bind an inference turn to one authorized connection, rechecking access before every request. */
export const bindModelProvider = async (
  model: Model,
): Promise<{ model: Model; wrapFetch: (fetch: FetchFn) => FetchFn; assertCurrent: () => Promise<void> }> => {
  const id = model.providerConnectionId
  if (!id) {
    return { model, wrapFetch: (fetch) => fetch, assertCurrent: async () => {} }
  }
  const db = getDb()
  const resolved = await resolveProviderConnection(db, id)
  if (resolved.connection.provider !== model.provider) {
    throw new Error('The model provider connection changed')
  }
  const resolveCurrent = async () => {
    const live = await resolveProviderConnection(db, id)
    if (
      live.revision !== resolved.revision ||
      live.connection.provider !== model.provider ||
      live.connection.url !== resolved.connection.url
    ) {
      throw new Error('The provider connection changed. Start a new request.')
    }
    return live
  }
  const wrapFetch = (fetch: FetchFn): FetchFn =>
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const live = await resolveCurrent()
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (model.provider === 'anthropic') {
          headers.set('x-api-key', live.apiKey)
        } else if (live.apiKey) {
          headers.set('Authorization', `Bearer ${live.apiKey}`)
        } else {
          headers.delete('Authorization')
        }
        return fetch(input, { ...init, headers })
      },
      { preconnect: fetch.preconnect },
    )
  return {
    model: { ...model, apiKey: resolved.apiKey, url: resolved.connection.url },
    wrapFetch,
    assertCurrent: async () => {
      await resolveCurrent()
    },
  }
}
