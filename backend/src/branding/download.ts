/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readBoundedBytes } from '@/utils/request-body'
import { BlockedUrlError, TooManyRedirectsError } from '@/utils/url-validation'

/** A branding file downloaded at startup, held in memory and served at `/config/branding/<name>`. */
export type BrandingFile = {
  /** Content-addressed, so a name never changes meaning and may be cached forever. */
  name: string
  bytes: Uint8Array<ArrayBuffer>
  type: string
}

export type BrandingLogger = {
  info: (context: Record<string, unknown>, message: string) => void
  warn: (context: Record<string, unknown>, message: string) => void
  error: (context: Record<string, unknown>, message: string) => void
}

/** The slice of `fetch` the downloads use, so the SSRF-safe wrapper fits. */
export type BrandingFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A download that fails the same way however often it is retried — a final
 * 4xx, a wrong type, a file over the limit: the operator's configuration must change.
 */
export class PermanentDownloadError extends Error {}

/**
 * Whether retrying a failed download could succeed. Network errors, timeouts,
 * 5xx, 408 and 429 can clear up; a refused URL, a redirect loop or a
 * configuration problem can't.
 *
 * @param error - What the download threw.
 */
export const isRetryable = (error: unknown): boolean =>
  !(
    error instanceof PermanentDownloadError ||
    error instanceof BlockedUrlError ||
    error instanceof TooManyRedirectsError
  )

/** How long one request may take, body included. */
export const requestTimeoutMs = 10_000

// 408 and 429 ask the client to come back later; every other 4xx is final.
const isPermanentStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429

/**
 * Fetch a URL with the download timeout and require an ok response. A
 * failure's body is cancelled rather than left holding the connection.
 *
 * @param url - The file to fetch.
 * @param fetchFn - The fetch to download with.
 * @throws {PermanentDownloadError} For a final 4xx; a plain error for anything retryable.
 */
export const fetchOk = async (url: string, fetchFn: BrandingFetch): Promise<Response> => {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(requestTimeoutMs) })
  if (response.ok) {
    return response
  }
  await response.body?.cancel()
  const message = `Request failed with ${response.status}`
  throw isPermanentStatus(response.status) ? new PermanentDownloadError(message) : new Error(message)
}

/**
 * A file's served name: the first 16 bytes of its SHA-256 in hex, plus its
 * extension. `shared/branding.ts` checks names against the same shape.
 *
 * @param bytes - The file's content.
 * @param extension - Without the dot, e.g. `woff2`.
 */
export const contentName = async (bytes: Uint8Array<ArrayBuffer>, extension: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex}.${extension}`
}

/**
 * A response body, refusing it once it passes `maxBytes` so an oversized file
 * is never buffered whole.
 *
 * @param response - An ok response.
 * @param maxBytes - The size limit.
 * @throws {PermanentDownloadError} When the body is larger than `maxBytes`.
 */
export const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
  const bytes = await readBoundedBytes(response, maxBytes)
  if (!bytes) {
    // Refused from `Content-Length`, the body is still open: release the connection.
    await response.body?.cancel()
    throw new PermanentDownloadError(`File is larger than the ${maxBytes}-byte limit`)
  }
  return bytes
}
