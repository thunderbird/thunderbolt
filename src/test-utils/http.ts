/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ResponsePromise } from '@/lib/http'

/**
 * Minimal stand-in for an `HttpClient` `ResponsePromise` whose JSON body is
 * already known, for `spyOn(http, 'get').mockReturnValue(...)` in tests. The
 * cast is unavoidable — `ResponsePromise` is a full `Promise<Response>` the
 * code under test never awaits directly — so it lives here once instead of
 * in every test file.
 */
export const stubJsonResponse = (payload: unknown): ResponsePromise =>
  ({ json: async () => payload }) as unknown as ResponsePromise
