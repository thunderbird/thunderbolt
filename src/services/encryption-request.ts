/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpError, type HttpClient, type ResponsePromise } from '@/lib/http'

/** An encrypted-sync transport or response body exceeded its request deadline. */
export class EncryptionRequestTimeoutError extends Error {
  constructor() {
    super('Encryption request timed out')
    this.name = 'EncryptionRequestTimeoutError'
  }
}

/** Bound each encryption request, including body reads, without releasing a pending local writer. */
export const createEncryptionOperationClient = (
  client: HttpClient,
  lifetime: AbortSignal,
  assertCurrent: () => void,
): HttpClient => {
  const scoped =
    (request: HttpClient['get']): HttpClient['get'] =>
    (url, options) => {
      assertCurrent()
      const controller = new AbortController()
      const signal = AbortSignal.any([lifetime, controller.signal, ...(options?.signal ? [options.signal] : [])])
      const response = request(url, { ...options, signal })
      const bounded = async <Value>(pending: Promise<Value>): Promise<Value> => {
        const cancellation = Promise.withResolvers<never>()
        const abort = () => cancellation.reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
        }
        const timer = setTimeout(() => {
          controller.abort(new EncryptionRequestTimeoutError())
        }, 10_000)
        try {
          const value = await Promise.race([cancellation.promise, pending])
          assertCurrent()
          return value
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
      }
      // Step-up refusal handlers read HttpError.response directly. Buffer that
      // body within the same bound before exposing the error outside this client.
      const result = bounded(response).catch(async (error: unknown) => {
        if (error instanceof HttpError) {
          const body = await bounded(error.response.text())
          error.response = new Response(body, {
            status: error.response.status,
            statusText: error.response.statusText,
            headers: error.response.headers,
          })
        }
        throw error
      }) as ResponsePromise
      result.json = <Value>() => bounded(result.then((value) => value.json() as Promise<Value>))
      result.text = () => bounded(result.then((value) => value.text()))
      return result
    }
  return { get: scoped(client.get), post: scoped(client.post), delete: scoped(client.delete) }
}
