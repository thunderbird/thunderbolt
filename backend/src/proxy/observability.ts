/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Logger } from 'pino'
import type { PostHog } from 'posthog-node'
import { trace } from '@opentelemetry/api'

/**
 * Classified error labels for the unified proxy. The set is closed —
 * never substitute raw error text. New labels must be added here so we keep
 * a stable, low-cardinality vocabulary across logs / spans / PostHog.
 */
export type ProxyErrorType =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'invalid_header'
  | 'method_not_allowed'
  | 'body_too_large'
  | 'ssrf_block'
  | 'dns_timeout'
  | 'too_many_redirects'
  | 'redirect_protocol'
  | 'rate_limit'
  | 'auth'
  | 'upstream_error'
  | 'cap_exceeded'
  | 'idle_timeout'
  | 'client_disconnect'

/**
 * Inputs for emitting one proxy observation. All identifying values that the
 * caller has on hand; the emitter is responsible for shaping them into the
 * various sinks (logger / PostHog / span attributes) without ever leaking
 * forbidden fields.
 */
export type ProxyObservationInput = {
  method: string
  /** Hostname only — never the full URL. */
  targetHost: string
  status: number
  durationMs: number
  userId: string
  requestId: string
  bytesIn: number
  bytesOut: number
  /** Safe label, not raw error text. Omit on success. */
  errorType?: ProxyErrorType
  /** Optional one-line message for logs only. Caller must guarantee it is safe. */
  errorMessage?: string
}

/** A side-effect that records one proxy observation across all wired sinks. */
export type ProxyObserver = (input: ProxyObservationInput) => void

/**
 * Build a proxy observer wired to the production logger, PostHog client, and
 * the active OpenTelemetry tracer (if any). The returned function is safe to
 * call from any path inside a proxy handler — it will not throw and will not
 * leak forbidden fields.
 *
 * Inject substitutes in tests (or pass `posthog: null` to disable analytics).
 */
export const createProxyObserver = (deps: { logger: Logger; posthog: PostHog | null }): ProxyObserver => {
  const { logger, posthog } = deps

  return (input) => {
    const span = trace.getActiveSpan()
    const traceId = span?.spanContext().traceId

    // Structured log entry — exactly one per request.
    logger.info(
      {
        event: 'proxy_request',
        method: input.method,
        target_host: input.targetHost,
        status: input.status,
        duration_ms: input.durationMs,
        user_id: input.userId,
        request_id: input.requestId,
        bytes_in: input.bytesIn,
        bytes_out: input.bytesOut,
        ...(input.errorType ? { error_type: input.errorType } : {}),
        ...(input.errorMessage ? { error: input.errorMessage } : {}),
        ...(traceId ? { trace_id: traceId } : {}),
      },
      'proxy_request',
    )

    // OpenTelemetry span — attach attributes if a span is active. We do NOT
    // start a new span; the @elysiajs/opentelemetry plugin already covers
    // the HTTP route span when instrumentation is enabled.
    if (span) {
      span.setAttributes({
        'proxy.method': input.method,
        'proxy.target_host': input.targetHost,
        'proxy.status': input.status,
        'proxy.duration_ms': input.durationMs,
        'proxy.user_id': input.userId,
        'proxy.request_id': input.requestId,
        'proxy.bytes_in': input.bytesIn,
        'proxy.bytes_out': input.bytesOut,
        ...(input.errorType ? { 'proxy.error_type': input.errorType } : {}),
      })
    }

    // PostHog $proxy_request event. Restricted property set:
    //  - target_host (hostname only)
    //  - method
    //  - status
    //  - duration_ms
    //  - proxy_kind: 'http' (literal — 'ws' reserved for future)
    //  - error_type (classified label only)
    // NEVER: bodies, full URL, headers, user_id.
    if (posthog) {
      posthog.capture({
        // PostHog requires distinctId. Use a fixed sentinel so events are NOT
        // tied to user_id (per spec). Anonymous server-side analytics only.
        distinctId: 'server',
        event: '$proxy_request',
        properties: {
          target_host: input.targetHost,
          method: input.method,
          status: input.status,
          duration_ms: input.durationMs,
          proxy_kind: 'http',
          ...(input.errorType ? { error_type: input.errorType } : {}),
        },
      })
    }
  }
}

/** No-op observer — used in tests that don't care about observability. */
export const noopProxyObserver: ProxyObserver = () => {}
