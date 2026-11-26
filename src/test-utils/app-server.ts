/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spyOn } from 'bun:test'

/** The URL the check before an import asks for: the module that makes the check, which the app's server hosts. */
const checkedUrl = new URL('../lib/import-when-reachable.ts', import.meta.url).href

/**
 * The app's server as the check made before a preview's code is imported sees it: up, answering with an error, down,
 * or taking the connection and never answering. Only a HEAD of the checked URL is answered; any other request fails.
 * A bundled build checks its own URL, so a test of one says which URL that is.
 */
export const stubAppServer = (
  answer: 'up' | 'error' | 'down' | 'silent' = 'up',
  isChecked = (url: string) => url === checkedUrl,
) => {
  const respond = async (input: RequestInfo | URL): Promise<Response> => {
    const request = new Request(input)
    if (request.method !== 'HEAD' || !isChecked(request.url)) {
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }
    if (answer === 'down') {
      throw new TypeError('Load failed')
    }
    if (answer === 'silent') {
      // Like a real fetch, it settles only when the request is aborted.
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)))
    }
    return new Response(null, { status: answer === 'up' ? 200 : 503 })
  }
  return spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  )
}
