/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient } from '@/lib/http'
import { fetch as nativeFetch } from '@/lib/fetch'

export const nativeSearchClient = createClient({
  fetch: (input, init) => {
    const options: RequestInit = { ...init, redirect: 'error' }
    return nativeFetch(input, options)
  },
})

/** Relays only the encrypted envelope to the app host; never sends app cookies or follows redirects. */
export const createBrowserSearchClient = (
  origin: string,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
) =>
  createClient({
    fetch: async (input, init) => {
      const request = new Request(input, init)
      return send(
        new Request(new URL('/_tinfoil/search', origin), {
          method: request.method,
          headers: request.headers,
          body: request.body ? await request.arrayBuffer() : undefined,
          signal: request.signal,
          credentials: 'omit',
          redirect: 'error',
        }),
      )
    },
  })
