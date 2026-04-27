/** Wire types for POST /v1/custom-model/proxy and /models. */

export type CustomModelProxyRequest = {
  targetUrl: string
  upstreamAuth?: string
  method: 'POST'
  body: unknown
  stream: boolean
}

export type CustomModelModelsRequest = {
  baseUrl: string
  upstreamAuth?: string
}

export type CustomModelModelsResponse = {
  data: Array<Record<string, unknown>>
}

export type ProxyErrorCode =
  | 'SSRF_BLOCKED'
  | 'INVALID_URL'
  | 'HOSTNAME_NOT_ALLOWED'
  | 'UPSTREAM_CONTENT_TYPE'
  | 'UPSTREAM_PROTOCOL'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'DNS_TIMEOUT'
  | 'BODY_TOO_LARGE'
  | 'SSE_LINE_TOO_LARGE'
  | 'RATE_LIMITED_USER'
  | 'RATE_LIMITED_HOST'
  | 'UNAUTHORIZED'

export type ProxyErrorEnvelope = {
  error: {
    code: ProxyErrorCode
    message: string
    httpStatus: number
  }
}
