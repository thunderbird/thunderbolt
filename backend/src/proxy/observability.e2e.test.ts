/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'

const mockDnsLookup = mock(() => Promise.resolve([{ address: '1.2.3.4', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))

import {
  authHeaders,
  createTestApp,
  createTestUpstream,
  createUpstreamRouter,
  type TestAppHandle,
} from '@/test-utils/e2e'
import { createObservabilityRecorder } from './observability'

/** Build a recorder whose logger and posthog client capture into local arrays.
 *  Tests pass this through createApp's `proxyObservability` dep — no module
 *  mocks, no cross-file leakage. */
const captureRecorder = () => {
  const logs: Array<Record<string, unknown>> = []
  const posthog: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }> = []
  const recorder = createObservabilityRecorder({
    logger: { info: (event) => logs.push(event as Record<string, unknown>) },
    posthog: { capture: (call) => posthog.push(call) },
  })
  return { recorder, logs, posthog }
}

describe('Universal proxy observability redaction', () => {
  let handle: TestAppHandle

  afterEach(async () => {
    if (handle) await handle.cleanup()
  })

  it('logs only target_host (hostname) — no full URL, path, or query, no header values', async () => {
    const upstream = createTestUpstream('observe.test', () => new Response('ok', { status: 200 }))
    const { recorder, logs, posthog } = captureRecorder()
    handle = await createTestApp({
      fetchFn: createUpstreamRouter({ 'observe.test': upstream }),
      proxyObservability: recorder,
    })

    const targetUrl = 'https://observe.test/secret-path?token=abc&user=eve'
    const sensitiveAuth = 'Bearer super-secret-upstream-key'
    const res = await handle.app.handle(
      new Request('http://localhost/v1/proxy', {
        method: 'GET',
        headers: {
          ...authHeaders(handle.bearerToken),
          'X-Proxy-Target-Url': targetUrl,
          'X-Proxy-Passthrough-Authorization': sensitiveAuth,
        },
      }),
    )
    expect(res.status).toBe(200)

    // onAfterResponse fires after the response — give it a tick.
    await new Promise((r) => setTimeout(r, 10))

    const allRecordedJson = JSON.stringify({ logs, posthog })

    // Hostname must appear (it's the proof of correctness, not a leak).
    expect(allRecordedJson).toContain('observe.test')

    // None of these may appear anywhere — full URL, query string, header values, or session credentials.
    expect(allRecordedJson).not.toContain('/secret-path')
    expect(allRecordedJson).not.toContain('token=abc')
    expect(allRecordedJson).not.toContain('user=eve')
    expect(allRecordedJson).not.toContain(sensitiveAuth)
    expect(allRecordedJson).not.toContain('super-secret-upstream-key')
    expect(allRecordedJson).not.toContain(handle.bearerToken)
    expect(allRecordedJson).not.toContain(handle.email)

    // Structured log shape.
    const proxyLogs = logs.filter((l) => (l as { event?: string }).event === 'proxy_request')
    expect(proxyLogs.length).toBeGreaterThan(0)
    expect((proxyLogs[0] as { target_host?: string }).target_host).toBe('observe.test')

    // PostHog event shape.
    const proxyEvents = posthog.filter((c) => c.event === '$proxy_request')
    expect(proxyEvents.length).toBeGreaterThan(0)
    expect(proxyEvents[0].properties.target_host).toBe('observe.test')
    expect(proxyEvents[0].properties.proxy_kind).toBe('http')
  })

  it('records the authenticated user_id, not the email or session token', async () => {
    const upstream = createTestUpstream('observe.test', () => new Response('ok', { status: 200 }))
    const { recorder, logs, posthog } = captureRecorder()
    handle = await createTestApp({
      fetchFn: createUpstreamRouter({ 'observe.test': upstream }),
      proxyObservability: recorder,
    })

    await handle.app.handle(
      new Request('http://localhost/v1/proxy', {
        method: 'GET',
        headers: {
          ...authHeaders(handle.bearerToken),
          'X-Proxy-Target-Url': 'https://observe.test/page',
        },
      }),
    )
    await new Promise((r) => setTimeout(r, 10))

    const proxyLog = logs.find((l) => (l as { event?: string }).event === 'proxy_request')
    expect(proxyLog).toBeDefined()
    const userId = (proxyLog as { user_id?: string }).user_id
    expect(userId).toBeTruthy()
    expect(userId).not.toBe('unknown')
    expect(userId).not.toBe(handle.email)

    // The user_id must also appear as PostHog distinctId, not the email.
    const proxyEvent = posthog.find((c) => c.event === '$proxy_request')
    expect(proxyEvent?.distinctId).toBe(userId)
    expect(proxyEvent?.distinctId).not.toBe(handle.email)
  })
})
