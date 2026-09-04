/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isSecureCloudUrl } from '../auth/config.ts'

export type CredentialedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type CredentialResponseObserver = (response: Response) => void | Promise<void>

/** Normalizes every Fetch input shape before enforcing the configured origin. */
const requestUrl = (input: string | URL | Request): URL => new URL(input instanceof Request ? input.url : input)
/** Keeps credentialed transports isolated to the async call chain that selected them. */
const fetchContext = new AsyncLocalStorage<CredentialedFetch>()
/** Retains the ambient implementation so unbound callers and nested dispatch never recurse. */
let fallbackFetch: CredentialedFetch = globalThis.fetch

/** Routes each call to its async-local transport, falling back to the captured ambient fetch. */
const dispatchCredentialedFetch: CredentialedFetch = (input, init) =>
  (fetchContext.getStore() ?? fallbackFetch)(input, init)

/** Installs one stable global dispatcher while preserving the latest ambient fetch beneath it. */
const installFetchDispatcher = (): void => {
  if (globalThis.fetch === dispatchCredentialedFetch) return
  fallbackFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: dispatchCredentialedFetch,
  })
}

/** Returns the ambient transport beneath the dispatcher without recursively selecting the dispatcher itself. */
export const getUncredentialedFetch = (): CredentialedFetch =>
  globalThis.fetch === dispatchCredentialedFetch ? fallbackFetch : globalThis.fetch

/** Creates a secure, origin-bound fetch that never follows redirects carrying replayable credentials. */
export const createCredentialedFetch = (
  baseUrl: string,
  fetchFn: CredentialedFetch = getUncredentialedFetch(),
  observeResponse: CredentialResponseObserver = () => {},
): CredentialedFetch => {
  if (!isSecureCloudUrl(baseUrl)) {
    throw new Error('Credentialed provider URLs must use https (or loopback http).')
  }
  const configuredOrigin = new URL(baseUrl).origin

  return async (input, init) => {
    if (requestUrl(input).origin !== configuredOrigin) {
      throw new Error('Credentialed provider requests must remain on their configured origin.')
    }
    const response = await fetchFn(input, { ...init, redirect: 'error' })
    try {
      await observeResponse(response)
    } catch (error) {
      console.error('Credential response observer failed.', error)
    }
    return response
  }
}

/** Isolates SDK construction/request startup in an async-local fetch context, including concurrent callers. */
export const withCredentialedFetch = <Value>(fetchFn: CredentialedFetch, run: () => Value): Value => {
  installFetchDispatcher()
  return fetchContext.run(fetchFn, run)
}
