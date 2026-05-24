/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Universal proxy observability — emits a structured `proxy_request` /
 * `proxy_ws_relay` event per request through Pino, and sets matching
 * attributes on the active OpenTelemetry span (so the proxy hop shows up in
 * traces under the same parent Elysia span). The full target URL never leaves
 * this module — only the hostname is recorded.
 *
 * No PostHog: the proxy is infra plumbing, not a product event surface. Pino
 * + OTel cover ops and incident response; product analytics shouldn't see
 * per-request proxy traffic.
 *
 * Logger is passed in by dependency injection (see createApp/AppDeps) so tests
 * can substitute a recorder fake without touching module mocks. This avoids
 * the test-pollution pattern global Pino mocks would produce — see
 * docs/development/testing.md.
 */

import { trace } from '@opentelemetry/api'

/**
 * Categorised proxy failure modes. Tagged on every failure path so dashboards
 * and alerts can distinguish a client-side mistake (`invalid_target`) from an
 * upstream outage (`upstream_5xx`) from an exfiltration attempt (`ssrf`).
 */
export type ProxyErrorType =
  | 'ssrf'
  | 'dns_timeout'
  | 'idle_timeout'
  | 'cap_exceeded'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'auth_reject'
  | 'invalid_target'

export type ProxyEventBase = {
  method: string
  /** Hostname only — never the full URL or path. */
  target_host: string
  status: number
  duration_ms: number
  /** Compressed bytes received from upstream (after `content-encoding`
   *  passthrough — what the wire actually carried). */
  bytes_in: number
  /** Bytes sent to the caller after the proxy's body cap. */
  bytes_out: number
  user_id: string
  request_id: string
  error_type?: ProxyErrorType
}

/** Minimal logger surface the proxy uses — narrower than Pino so tests
 *  can pass a one-method recorder without dragging in the full type. */
export type ProxyLogger = {
  info: (event: object) => void
}

export type ProxyRequestFields = Omit<ProxyEventBase, 'target_host'> & { target_url: string }

export type ProxyWsRelayFields = Omit<ProxyEventBase, 'target_host' | 'status' | 'bytes_in' | 'bytes_out'> & {
  target_url: string
  close_code: number
  /** Optional free-form failure reason — used to surface upstream-derived
   *  diagnostic text the typed `error_type` enum cannot capture (e.g. the
   *  upstream WS server's `CloseEvent.reason`, or the OS-level message from a
   *  synchronous `new WebSocket(url)` failure). Categorical alerting should
   *  key off `error_type`; this field is for incident-response context only. */
  error?: string
}

export type ObservabilityRecorder = {
  proxyRequest: (fields: ProxyRequestFields) => void
  proxyWsRelay: (fields: ProxyWsRelayFields) => void
}

const safeHostname = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return 'unknown'
  }
}

/** Set proxy-namespaced attributes on the active OTel span (if any). No-ops
 *  cleanly when tracing isn't configured — `trace.getActiveSpan()` returns
 *  undefined and the chained call short-circuits. */
const recordSpanAttributes = (attrs: Record<string, string | number | undefined>) => {
  const span = trace.getActiveSpan()
  if (!span) {
    return
  }
  const filtered: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      filtered[key] = value
    }
  }
  span.setAttributes(filtered)
}

/** Build a recorder bound to a specific logger. Pass `null` to disable
 *  logging (OTel attributes are still set on the active span). */
export const createObservabilityRecorder = (deps: { logger: ProxyLogger | null }): ObservabilityRecorder => {
  const emitLog = (event: object) => {
    if (!deps.logger) {
      return
    }
    deps.logger.info(event)
  }

  return {
    proxyRequest(fields) {
      const targetHost = safeHostname(fields.target_url)
      emitLog({
        event: 'proxy_request',
        method: fields.method,
        target_host: targetHost,
        status: fields.status,
        duration_ms: fields.duration_ms,
        bytes_in: fields.bytes_in,
        bytes_out: fields.bytes_out,
        user_id: fields.user_id,
        request_id: fields.request_id,
        ...(fields.error_type ? { error_type: fields.error_type } : {}),
      })
      recordSpanAttributes({
        'proxy.target_host': targetHost,
        'proxy.method': fields.method,
        'proxy.status': fields.status,
        'proxy.duration_ms': fields.duration_ms,
        'proxy.bytes_in': fields.bytes_in,
        'proxy.bytes_out': fields.bytes_out,
        'proxy.error_type': fields.error_type,
      })
    },
    proxyWsRelay(fields) {
      const targetHost = safeHostname(fields.target_url)
      emitLog({
        event: 'proxy_ws_relay',
        method: 'WS',
        target_host: targetHost,
        status: fields.close_code,
        duration_ms: fields.duration_ms,
        user_id: fields.user_id,
        request_id: fields.request_id,
        ...(fields.error_type ? { error_type: fields.error_type } : {}),
        ...(fields.error ? { error: fields.error } : {}),
      })
      recordSpanAttributes({
        'proxy.target_host': targetHost,
        'proxy.method': 'WS',
        'proxy.status': fields.close_code,
        'proxy.duration_ms': fields.duration_ms,
        'proxy.error_type': fields.error_type,
      })
    },
  }
}

/** No-op recorder for tests/contexts that don't care about observability. */
export const noopObservability: ObservabilityRecorder = createObservabilityRecorder({ logger: null })
