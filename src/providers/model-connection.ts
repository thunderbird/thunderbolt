/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { nativeFetch } from '@/lib/native-fetch'
import { getDb } from '@/db/database'
import { resolveProviderConnection } from '@/dal/provider-connections'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { getIdentitySignal } from '@/lib/identity-lifetime'

/** Bind an inference turn to one authorized connection, rechecking access before every request. */
export const bindModelProvider = async (
  model: Model,
): Promise<{
  api?: 'openai-responses'
  model: Model
  wrapFetch: (fetch: FetchFn) => FetchFn
  assertCurrent: () => Promise<void>
}> => {
  const id = model.providerConnectionId
  if (!id) {
    return { model, wrapFetch: (fetch) => fetch, assertCurrent: async () => {} }
  }
  const identity = getIdentitySignal()
  const db = getDb()
  const resolved = await resolveProviderConnection(db, id)
  identity.throwIfAborted()
  if (resolved.connection.provider !== model.provider) {
    throw new Error('The model provider connection changed')
  }
  const isChatGPT = resolved.connection.provider === 'openai' && resolved.connection.authMethod === 'oauth'
  const resolveCurrent = async () => {
    identity.throwIfAborted()
    const live = await resolveProviderConnection(db, id)
    identity.throwIfAborted()
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
        const callerSignal =
          init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
        const signal = AbortSignal.any([identity, ...(callerSignal ? [callerSignal] : [])])
        signal.throwIfAborted()
        const live = await resolveCurrent()
        signal.throwIfAborted()
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (model.provider === 'anthropic') {
          headers.set('x-api-key', live.apiKey)
        } else if (live.apiKey) {
          headers.set('Authorization', `Bearer ${live.apiKey}`)
        } else {
          headers.delete('Authorization')
        }
        if (isChatGPT) {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.href !== 'https://api.openai.com/v1/responses') {
            throw new Error('ChatGPT plan access requires the public Responses API')
          }
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : await (input as Request).text(),
          ) as Record<string, unknown>
          if (body.stream !== true) {
            throw new Error('ChatGPT plan access requires streaming')
          }
          return nativeFetch(input, {
            ...init,
            headers,
            signal,
            redirect: 'error',
            body: JSON.stringify({ ...body, store: false }),
          })
        }
        return fetch(input, { ...init, headers, signal })
      },
      { preconnect: fetch.preconnect },
    )
  return {
    ...(isChatGPT ? { api: 'openai-responses' as const } : {}),
    model: { ...model, apiKey: resolved.apiKey, url: resolved.connection.url },
    wrapFetch,
    assertCurrent: async () => {
      await resolveCurrent()
    },
  }
}
