/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Lightweight HTTP client replacing ky.
 * Provides .get()/.post()/.delete() with auto JSON parsing,
 * error throwing on non-2xx, prefixUrl, and beforeRequest hooks.
 */

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
  hooks?: { beforeRequest?: Array<(request: Request) => void> }
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
    }

    const fetchFn = options.fetch ?? config.fetch ?? globalThis.fetch

    let signal = options.signal
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (options.timeout && !signal) {
      const controller = new AbortController()
      signal = controller.signal
      timeoutId = setTimeout(() => controller.abort(), options.timeout)
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
 * Skips setting the token if the caller already provided an Authorization header. */
export const createAuthenticatedClient = (
  prefixUrl: string,
  getToken: () => string | null,
  config: Pick<HttpClientConfig, 'fetch' | 'credentials'> = {},
): HttpClient =>
  createClient({
    prefixUrl,
    fetch: config.fetch,
    credentials: config.credentials,
    hooks: {
      beforeRequest: [
        (request) => {
          if (request.headers.has('Authorization')) {
            return
          }
          const token = getToken()
          if (token) {
            request.headers.set('Authorization', `Bearer ${token}`)
          }
        },
      ],
    },
  })

/** Default client with no config — use for external API calls that don't need auth or prefixUrl. */
export const http = createClient()
