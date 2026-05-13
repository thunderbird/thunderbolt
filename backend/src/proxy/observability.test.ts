/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the proxy observability recorder. Exercises the real
 * implementation directly — no DI of internals, no module mocks. The
 * `proxyRequest` and `proxyWsRelay` shape is the wire contract between the
 * proxy core (`routes.ts`, `ws.ts`) and downstream log/trace consumers.
 *
 * OTel side-effects (`trace.getActiveSpan().setAttributes(...)`) are exercised
 * by running inside an `tracer.startActiveSpan` block and inspecting the span
 * via an in-memory exporter — see the `OTel span attributes` describe block.
 */

import { describe, expect, it } from 'bun:test'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks'
import { context, trace } from '@opentelemetry/api'
import { createObservabilityRecorder, noopObservability, type ProxyErrorType } from './observability'

const captureLogger = () => {
  const events: Array<Record<string, unknown>> = []
  return {
    logger: { info: (event: object) => events.push(event as Record<string, unknown>) },
    events,
  }
}

describe('createObservabilityRecorder — proxyRequest', () => {
  it('emits a proxy_request log with only the hostname (never the full URL)', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyRequest({
      method: 'GET',
      target_url: 'https://example.com/secret/path?token=abc',
      status: 200,
      duration_ms: 42,
      bytes_in: 100,
      bytes_out: 2048,
      user_id: 'user-1',
      request_id: 'req-1',
    })

    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.event).toBe('proxy_request')
    expect(e.target_host).toBe('example.com')
    // No part of the URL or query may leak into the structured event.
    const serialised = JSON.stringify(e)
    expect(serialised).not.toContain('/secret/path')
    expect(serialised).not.toContain('token=abc')
  })

  it('records bytes_in, bytes_out and duration_ms verbatim from the caller', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyRequest({
      method: 'POST',
      target_url: 'https://api.example.com/v1/chat',
      status: 200,
      duration_ms: 1234,
      bytes_in: 9001,
      bytes_out: 4242,
      user_id: 'user-2',
      request_id: 'req-2',
    })
    const e = events[0]
    expect(e.bytes_in).toBe(9001)
    expect(e.bytes_out).toBe(4242)
    expect(e.duration_ms).toBe(1234)
    expect(e.status).toBe(200)
    expect(e.method).toBe('POST')
  })

  it('falls back to "unknown" for an unparseable target_url', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyRequest({
      method: 'GET',
      target_url: '',
      status: 400,
      duration_ms: 1,
      bytes_in: 0,
      bytes_out: 0,
      user_id: 'user-3',
      request_id: 'req-3',
      error_type: 'invalid_target',
    })
    expect(events[0].target_host).toBe('unknown')
  })

  it('omits error_type from the log when no failure occurred', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyRequest({
      method: 'GET',
      target_url: 'https://example.com',
      status: 200,
      duration_ms: 5,
      bytes_in: 0,
      bytes_out: 1024,
      user_id: 'u',
      request_id: 'r',
    })
    expect(events[0]).not.toHaveProperty('error_type')
  })

  it('includes error_type when the request failed', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    const errorTypes: ProxyErrorType[] = [
      'ssrf',
      'dns_timeout',
      'idle_timeout',
      'cap_exceeded',
      'upstream_5xx',
      'upstream_4xx',
      'auth_reject',
      'invalid_target',
    ]
    for (const et of errorTypes) {
      events.length = 0
      rec.proxyRequest({
        method: 'GET',
        target_url: 'https://example.com',
        status: 502,
        duration_ms: 1,
        bytes_in: 0,
        bytes_out: 0,
        user_id: 'u',
        request_id: 'r',
        error_type: et,
      })
      expect(events[0].error_type).toBe(et)
    }
  })

  it('no-ops cleanly when logger is null', () => {
    const rec = createObservabilityRecorder({ logger: null })
    // Should not throw.
    rec.proxyRequest({
      method: 'GET',
      target_url: 'https://example.com',
      status: 200,
      duration_ms: 1,
      bytes_in: 0,
      bytes_out: 0,
      user_id: 'u',
      request_id: 'r',
    })
  })
})

describe('createObservabilityRecorder — proxyWsRelay', () => {
  it('emits a proxy_ws_relay log with hostname and close code', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyWsRelay({
      method: 'WS',
      target_url: 'wss://realtime.example.com/socket',
      close_code: 1000,
      duration_ms: 500,
      user_id: 'user-1',
      request_id: 'req-1',
    })
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.event).toBe('proxy_ws_relay')
    expect(e.method).toBe('WS')
    expect(e.target_host).toBe('realtime.example.com')
    expect(e.status).toBe(1000)
    expect(e.duration_ms).toBe(500)
    // No path leakage.
    expect(JSON.stringify(e)).not.toContain('/socket')
  })

  it('forwards optional free-form `error` field on WS close', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyWsRelay({
      method: 'WS',
      target_url: 'wss://realtime.example.com/socket',
      close_code: 1006,
      duration_ms: 200,
      user_id: 'u',
      request_id: 'r',
      error: 'abnormal closure',
    })
    expect(events[0].error).toBe('abnormal closure')
  })

  it('forwards categorical error_type for proxy-initiated WS closes', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    const errorTypes: ProxyErrorType[] = ['invalid_target', 'cap_exceeded', 'upstream_5xx']
    for (const et of errorTypes) {
      events.length = 0
      rec.proxyWsRelay({
        method: 'WS',
        target_url: 'wss://realtime.example.com/',
        close_code: 1011,
        duration_ms: 1,
        user_id: 'u',
        request_id: 'r',
        error_type: et,
      })
      expect(events[0].error_type).toBe(et)
    }
  })

  it('omits error_type from the log when the WS close was clean', () => {
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyWsRelay({
      method: 'WS',
      target_url: 'wss://realtime.example.com/',
      close_code: 1000,
      duration_ms: 5,
      user_id: 'u',
      request_id: 'r',
    })
    expect(events[0]).not.toHaveProperty('error_type')
  })

  it('keeps `error` and `error_type` independent — both can coexist', () => {
    // The free-form `error` carries upstream-derived text (CloseEvent.reason,
    // sync constructor failure message) that the typed enum cannot capture;
    // the recorder must surface both side-by-side for incident response.
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyWsRelay({
      method: 'WS',
      target_url: 'wss://realtime.example.com/',
      close_code: 1011,
      duration_ms: 5,
      user_id: 'u',
      request_id: 'r',
      error_type: 'upstream_5xx',
      error: 'connect ECONNREFUSED 127.0.0.1:1',
    })
    expect(events[0].error_type).toBe('upstream_5xx')
    expect(events[0].error).toBe('connect ECONNREFUSED 127.0.0.1:1')
  })
})

describe('noopObservability', () => {
  it('does not throw on any call', () => {
    noopObservability.proxyRequest({
      method: 'GET',
      target_url: 'https://example.com',
      status: 200,
      duration_ms: 1,
      bytes_in: 0,
      bytes_out: 0,
      user_id: 'u',
      request_id: 'r',
    })
    noopObservability.proxyWsRelay({
      method: 'WS',
      target_url: 'wss://example.com',
      close_code: 1000,
      duration_ms: 1,
      user_id: 'u',
      request_id: 'r',
    })
  })
})

describe('OTel span attributes', () => {
  /** Spin up an isolated SDK + AsyncHooks context manager so `trace.getActiveSpan()`
   *  resolves inside `startActiveSpan` callbacks. Without the context manager the
   *  global context never propagates and the recorder sees no active span.
   *
   *  Order matters across test boundaries: `trace.disable()` + `context.disable()`
   *  must run before reinstalling, otherwise the second test inherits the prior
   *  test's provider and span processors. */
  const setupTracer = () => {
    trace.disable()
    context.disable()
    const contextManager = new AsyncHooksContextManager()
    contextManager.enable()
    context.setGlobalContextManager(contextManager)
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
    const tracer = provider.getTracer('proxy-test')
    return {
      exporter,
      tracer,
      provider,
      teardown: () => {
        contextManager.disable()
      },
    }
  }

  it('sets proxy.* attributes on the active span during proxyRequest', async () => {
    const { exporter, tracer, teardown } = setupTracer()
    try {
      const { logger } = captureLogger()
      const rec = createObservabilityRecorder({ logger })

      tracer.startActiveSpan('test-span', (span) => {
        rec.proxyRequest({
          method: 'POST',
          target_url: 'https://api.example.com/chat',
          status: 200,
          duration_ms: 42,
          bytes_in: 100,
          bytes_out: 5000,
          user_id: 'u',
          request_id: 'r',
        })
        span.end()
      })

      const exported = exporter.getFinishedSpans()
      expect(exported).toHaveLength(1)
      const attrs = exported[0].attributes
      expect(attrs['proxy.target_host']).toBe('api.example.com')
      expect(attrs['proxy.method']).toBe('POST')
      expect(attrs['proxy.status']).toBe(200)
      expect(attrs['proxy.duration_ms']).toBe(42)
      expect(attrs['proxy.bytes_in']).toBe(100)
      expect(attrs['proxy.bytes_out']).toBe(5000)
      // No error_type when the request succeeded.
      expect(attrs['proxy.error_type']).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('sets proxy.error_type on the active span when a failure is recorded', async () => {
    const { exporter, tracer, teardown } = setupTracer()
    try {
      const { logger } = captureLogger()
      const rec = createObservabilityRecorder({ logger })

      tracer.startActiveSpan('test-span', (span) => {
        rec.proxyRequest({
          method: 'GET',
          target_url: 'https://internal.example.com',
          status: 400,
          duration_ms: 3,
          bytes_in: 0,
          bytes_out: 0,
          user_id: 'u',
          request_id: 'r',
          error_type: 'ssrf',
        })
        span.end()
      })

      const exported = exporter.getFinishedSpans()
      expect(exported[0].attributes['proxy.error_type']).toBe('ssrf')
    } finally {
      teardown()
    }
  })

  it('is a clean no-op when no active span exists', () => {
    // No active span — trace.getActiveSpan() returns undefined; setAttributes
    // must not be called and the recorder must not throw.
    const { logger, events } = captureLogger()
    const rec = createObservabilityRecorder({ logger })
    rec.proxyRequest({
      method: 'GET',
      target_url: 'https://example.com',
      status: 200,
      duration_ms: 1,
      bytes_in: 0,
      bytes_out: 0,
      user_id: 'u',
      request_id: 'r',
    })
    expect(events).toHaveLength(1)
  })
})
