/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ResponsePromise } from '@/lib/http'

/**
 * Stand-in for an `HttpClient` `ResponsePromise` whose JSON body is already
 * known, for `spyOn(http, 'get').mockReturnValue(...)` in tests. Built the
 * same way as the production `makeResponsePromise`: a genuine
 * `Promise<Response>` widened with the `json`/`text` helpers, so code that
 * awaits the promise directly works too.
 */
export const stubJsonResponse = (payload: unknown): ResponsePromise => {
  const body = JSON.stringify(payload)
  const promise = Promise.resolve(new Response(body)) as ResponsePromise
  promise.json = <T>() => Promise.resolve(payload as T)
  promise.text = () => Promise.resolve(body)
  return promise
}
