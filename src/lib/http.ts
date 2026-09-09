/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Lightweight HTTP client replacing ky.
 * Provides .get()/.post()/.delete() with auto JSON parsing,
 * error throwing on non-2xx, prefixUrl, and beforeRequest hooks.
 */

// Imported from the leaf module rather than `@/i18n` so this client keeps out of
// Lingui's dependency graph (the barrel pulls in @lingui/core and the catalog
// loader map).
import { getActiveLocale } from '@/i18n/active-locale'
import { appVersionHeader } from '@/lib/app-version'
import { handleAppVersionUnsupported } from '@/lib/app-version-unsupported'
import { getDeviceId } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'

export class HttpError extends Error {
  response: Response
  constructor(response: Response) {
    super(`Request failed with status ${response.status}`)
    this.name = 'HttpError'
    this.response = response
  }
}

export type RequestOptions = {
  headers?: Record<string, string>
  searchParams?: Record<string, string | number | boolean | undefined> | URLSearchParams
  timeout?: number
  json?: unknown
  /** Raw request body (e.g. FormData, Blob) for non-JSON posts. Ignored if `json` is set. */
  body?: BodyInit
  credentials?: RequestCredentials
  signal?: AbortSignal
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export type ResponsePromise = Promise<Response> & {
  json: <T>() => Promise<T>
  text: () => Promise<string>
}

export type HttpClient = {
  get: (url: string, options?: RequestOptions) => ResponsePromise
  post: (url: string, options?: RequestOptions) => ResponsePromise
  delete: (url: string, options?: RequestOptions) => ResponsePromise
}

type HttpClientConfig = {
  prefixUrl?: string
  credentials?: RequestCredentials
  hooks?: {
    beforeRequest?: Array<(request: Request) => void>
    afterResponse?: Array<(request: Request, response: Response) => void>
  }
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const appendSearchParams = (url: string, searchParams: RequestOptions['searchParams']): string => {
  if (!searchParams) {
    return url
  }

  let params: URLSearchParams
  if (searchParams instanceof URLSearchParams) {
    params = searchParams
  } else {
    params = new URLSearchParams()
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        params.set(key, String(value))
      }
    }
  }

  const qs = params.toString()
  if (!qs) {
    return url
  }
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`
}

const resolveUrl = (url: string, prefixUrl?: string): string => {
  if (!prefixUrl || url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }
  const base = prefixUrl.endsWith('/') ? prefixUrl : `${prefixUrl}/`
  return `${base}${url}`
}

/** Match a request against the configured backend origin and path prefix. */
const isBackendRequest = (requestUrl: string, backendUrl: URL): boolean => {
  const request = new URL(requestUrl)
  const backendPath = backendUrl.pathname.replace(/\/+$/, '')

  return (
    request.origin === backendUrl.origin &&
    (backendPath === '' || request.pathname === backendPath || request.pathname.startsWith(`${backendPath}/`))
  )
}

const makeResponsePromise = (promise: Promise<Response>): ResponsePromise => {
  const rp = promise as ResponsePromise
  rp.json = <T>(): Promise<T> => promise.then((res) => res.json())
  rp.text = () => promise.then((res) => res.text())
  return rp
}

export const createClient = (config: HttpClientConfig = {}): HttpClient => {
  const request = (method: string, url: string, options: RequestOptions = {}): ResponsePromise => {
    const fullUrl = appendSearchParams(resolveUrl(url, config.prefixUrl), options.searchParams)

    const headers = new Headers(options.headers)
    let body: BodyInit | undefined

    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(options.json)
    } else if (options.body !== undefined) {
      // Raw body (FormData/Blob/…) — leave Content-Type to the caller/browser
      // (e.g. FormData needs the auto-generated multipart boundary).
      body = options.body
    }

    const fetchFn = options.fetch ?? config.fetch ?? globalThis.fetch

    // Honor `timeout` even when the caller also passes a `signal` — compose the
    // two so an aborted turn AND an elapsed timeout both cancel the request.
    // (Without this, a slow/hung server on a request that carries a signal would
    // never time out, e.g. a voice STT/TTS turn stuck indefinitely.)
    let signal = options.signal
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (options.timeout) {
      const controller = new AbortController()
      timeoutId = setTimeout(
        () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
        options.timeout,
      )
      signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    }

    const req = new Request(fullUrl, {
      method,
      headers,
      body,
      credentials: options.credentials ?? config.credentials,
      signal,
    })

    config.hooks?.beforeRequest?.forEach((hook) => hook(req))

    const responsePromise = fetchFn(req)
      .then((response) => {
        config.hooks?.afterResponse?.forEach((hook) => hook(req, response))
        if (!response.ok) {
          throw new HttpError(response)
        }
        return response
      })
      .finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
      })

    return makeResponsePromise(responsePromise)
  }

  return {
    get: (url, options) => request('GET', url, options),
    post: (url, options) => request('POST', url, options),
    delete: (url, options) => request('DELETE', url, options),
  }
}

/** Create an authenticated client that attaches a Bearer token from localStorage on each request.
 * Skips setting the token if the caller already provided an Authorization header.
 * Dispatches `powersync_credentials_invalid` (reason: `session_expired`) when an authenticated
 * request to the app backend returns 401, so the app can prompt the user to re-authenticate.
 * External-API 401s (e.g. Google/Microsoft OAuth) are ignored — those use the same client but
 * with caller-provided OAuth tokens, and are not signals of an expired app session. */
export const createAuthenticatedClient = (
  prefixUrl: string,
  getToken: () => string | null,
  config: Pick<HttpClientConfig, 'fetch' | 'credentials'> = {},
): HttpClient => {
  const backendUrl =
    prefixUrl.startsWith('http://') || prefixUrl.startsWith('https://')
      ? new URL(prefixUrl)
      : new URL(prefixUrl, window.location.href)
  return createClient({
    prefixUrl: backendUrl.href,
    fetch: config.fetch,
    credentials: config.credentials,
    hooks: {
      beforeRequest: [
        (request) => {
          if (!request.headers.has('Authorization')) {
            const token = getToken()
            if (token) {
              request.headers.set('Authorization', `Bearer ${token}`)
            }
          }
          // Inject device identity headers only for app backend requests (not external APIs).
          // Uses the same prefix guard as the afterResponse 401 handler below.
          if (isBackendRequest(request.url, backendUrl)) {
            const deviceId = getDeviceId()
            if (deviceId) {
              request.headers.set('X-Device-ID', deviceId)
              request.headers.set('X-Device-Name', getDeviceDisplayName())
            }
            for (const [key, value] of Object.entries(appVersionHeader())) {
              request.headers.set(key, value)
            }
            // A single resolved tag, not a preference list — the client has already
            // negotiated, so the backend forwards rather than re-negotiates.
            request.headers.set('X-App-Language', getActiveLocale())
          }
        },
      ],
      afterResponse: [
        // Event name + reason kept in sync with src/db/powersync/connector.ts. Importing from there
        // would create a cycle (connector → sync-tracker → posthog → http).
        (request, response) => {
          // Only app-backend responses are actionable — external APIs use this same
          // client with caller-provided tokens, so their 401/426 are not signals about
          // our app session or app version. Same prefix guard as the beforeRequest hook.
          if (!isBackendRequest(request.url, backendUrl)) {
            return
          }
          // A 426 from our backend means this build is below the enforced minimum —
          // status-only (the body stream belongs to the caller).
          if (response.status === 426) {
            handleAppVersionUnsupported(response.status)
            return
          }
          if (response.status === 401 && request.headers.has('Authorization')) {
            window.dispatchEvent(
              new CustomEvent('powersync_credentials_invalid', { detail: { reason: 'session_expired' } }),
            )
          }
        },
      ],
    },
  })
}

/** Default client with no config — use for external API calls that don't need auth or prefixUrl. */
export const http = createClient()
