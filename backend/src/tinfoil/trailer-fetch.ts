/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream'

export type TinfoilFetchInit = {
  method: string
  headers: HeadersInit
  body?: ReadableStream<Uint8Array> | null
  signal: AbortSignal
}

/** A response whose HTTP trailers settle once its body ends, or null when the body never completes. */
export type TinfoilResponse = Response & { trailers?: Promise<Headers | null> }

/** The upstream transport for Tinfoil. A plain `fetch` fits too, for callers that never read trailers. */
export type TinfoilFetch = (url: string, init: TinfoilFetchInit) => Promise<TinfoilResponse>

const nullBodyStatuses = new Set([101, 204, 205, 304])

/** Copy node's raw header pairs, keeping repeated names. */
const toHeaders = (rawPairs: string[]): Headers => {
  const headers = new Headers()
  for (let index = 0; index < rawPairs.length; index += 2) {
    headers.append(rawPairs[index], rawPairs[index + 1])
  }
  return headers
}

/** Resolve the trailers on a clean end of the body, and null if the response errors or closes first. */
const readTrailers = (response: IncomingMessage): Promise<Headers | null> =>
  new Promise((resolve) => {
    response.once('end', () => resolve(toHeaders(response.rawTrailers)))
    // The error listener also stops a reset on a bodiless response from becoming an uncaught exception.
    response.on('error', () => resolve(null))
    response.once('close', () => resolve(null))
  })

/** Expose a message as a web stream. Cancelling the stream destroys the message, and a message error fails the stream. */
const toWebStream = (message: IncomingMessage): ReadableStream<Uint8Array> => {
  const chunks = message[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const { value, done } = await chunks.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel: () => {
      message.destroy()
    },
  })
}

/**
 * Fetch through Bun's `node:http(s)`. Bun's `fetch` drops HTTP trailers, and Tinfoil sends a stream's usage in one.
 * This needs Bun 1.4 or newer, because 1.3 drops trailers here too. Redirects are returned rather than followed, the
 * body stays encoded, and an abort before the response headers rejects with the signal's reason, as `fetch` does.
 */
export const fetchWithTrailers: TinfoilFetch = (url, { method, headers, body, signal }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(target, { method, headers: Object.fromEntries(new Headers(headers)), signal }, (response) => {
      const status = response.statusCode ?? 502
      const trailers = readTrailers(response)
      const hasBody = !nullBodyStatuses.has(status)
      if (!hasBody) {
        response.resume()
      }
      const responseBody = hasBody ? toWebStream(response) : null
      const headersOut = toHeaders(response.rawHeaders)
      resolve(
        Object.assign(new Response(responseBody, { status, statusText: response.statusMessage, headers: headersOut }), {
          trailers,
        }),
      )
    })
    request.on('error', (error) => reject(signal.aborted ? signal.reason : error))
    if (body) {
      // A failed upload destroys the request, so it surfaces through the error listener above.
      pipeline(body, request, () => {})
    } else {
      request.end()
    }
  })
