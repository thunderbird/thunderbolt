/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Universal proxy observability — emits a structured `proxy_request` /
 * `proxy_ws_relay` event per request, plus a privacy-mode PostHog
 * `$proxy_request` event. The full target URL never leaves this module —
 * only the hostname is recorded.
 *
 * Logger and PostHog client are passed in by dependency injection (see
 * createApp/AppDeps) so tests can substitute fakes without touching module
 * mocks. This avoids the test-pollution pattern the global Pino/PostHog
 * mocks would produce — see docs/development/testing.md.
 */

export type ProxyEventBase = {
  method: string
  /** Hostname only — never the full URL or path. */
  target_host: string
  status: number
  duration_ms: number
  user_id: string
  request_id: string
  bytes_in: number
  bytes_out: number
  error?: string
}

/** Minimal logger surface the proxy uses — narrower than Pino so tests
 *  can pass a one-method recorder without dragging in the full type. */
export type ProxyLogger = {
  info: (event: object) => void
}

/** Minimal PostHog client surface the proxy uses. */
export type ProxyPostHog = {
  capture: (call: { distinctId: string; event: string; properties: Record<string, unknown> }) => void
}

export type ObservabilityRecorder = {
  proxyRequest: (fields: Omit<ProxyEventBase, 'target_host'> & { target_url: string }) => void
  proxyWsRelay: (
    fields: Omit<ProxyEventBase, 'target_host' | 'status'> & {
      target_url: string
      close_code: number
    },
  ) => void
}

const safeHostname = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return 'unknown'
  }
}

/** Build a recorder bound to a specific logger + posthog client. Pass nulls
 *  to disable either output. */
export const createObservabilityRecorder = (deps: {
  logger: ProxyLogger | null
  posthog: ProxyPostHog | null
}): ObservabilityRecorder => {
  const emitLog = (event: object) => {
    if (!deps.logger) return
    try {
      deps.logger.info(event)
    } catch {
      // logger failure is never fatal
    }
  }

  const emitPostHog = (distinctId: string, properties: Record<string, unknown>, error?: string) => {
    if (!deps.posthog) return
    try {
      deps.posthog.capture({
        distinctId,
        event: '$proxy_request',
        properties: {
          ...properties,
          ...(error ? { error_type: 'upstream_error' } : {}),
        },
      })
    } catch {
      // PostHog failure is never fatal
    }
  }

  return {
    proxyRequest(fields) {
      const target_host = safeHostname(fields.target_url)
      emitLog({
        event: 'proxy_request',
        method: fields.method,
        target_host,
        status: fields.status,
        duration_ms: fields.duration_ms,
        user_id: fields.user_id,
        request_id: fields.request_id,
        bytes_in: fields.bytes_in,
        bytes_out: fields.bytes_out,
        ...(fields.error ? { error: fields.error } : {}),
      })
      emitPostHog(
        fields.user_id,
        {
          target_host,
          method: fields.method,
          status: fields.status,
          duration_ms: fields.duration_ms,
          proxy_kind: 'http' as const,
        },
        fields.error,
      )
    },
    proxyWsRelay(fields) {
      const target_host = safeHostname(fields.target_url)
      emitLog({
        event: 'proxy_ws_relay',
        method: 'WS',
        target_host,
        status: fields.close_code,
        duration_ms: fields.duration_ms,
        user_id: fields.user_id,
        request_id: fields.request_id,
        bytes_in: fields.bytes_in,
        bytes_out: fields.bytes_out,
        ...(fields.error ? { error: fields.error } : {}),
      })
      emitPostHog(
        fields.user_id,
        {
          target_host,
          method: 'WS',
          status: fields.close_code,
          duration_ms: fields.duration_ms,
          proxy_kind: 'ws' as const,
        },
        fields.error,
      )
    },
  }
}

/** No-op recorder for tests/contexts that don't care about observability. */
export const noopObservability: ObservabilityRecorder = createObservabilityRecorder({
  logger: null,
  posthog: null,
})
