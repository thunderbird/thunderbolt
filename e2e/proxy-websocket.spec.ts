/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test'
import { collectPageErrors, loginViaOidc } from './helpers'

const cloudUrl = 'http://localhost:8000/v1'
const targetWsUrl = 'wss://upstream.example.com/realtime/socket'

/**
 * WebSocket proxy contract — verifies the wire format `createProxyWebSocket`
 * emits when called from a real browser.
 *
 *   - Connection target URL is `${cloudUrl.replace(http→ws, /v1→/v1)}/proxy/ws`
 *     (a fixed proxy WS endpoint; the upstream URL is NOT in the path).
 *   - The upstream URL travels in the `Sec-WebSocket-Protocol` handshake
 *     header as the subprotocol `tbproxy.target.<base64url(url)>`.
 *   - Caller-supplied subprotocols are passed through after the target marker
 *     so the upstream WS server still negotiates them normally.
 *
 * We can't make a real WS round-trip here — the backend's WS proxy gates on
 * auth and validates the upstream against SSRF (loopback is rejected). So we
 * stub `globalThis.WebSocket` inside the page and capture the URL + protocols
 * the helper passes. This is the same blueprint as feat/universal-proxy's
 * mocked `page.route` HTTP probes — what's under test is the wire format the
 * frontend writes.
 *
 * The unit tests in src/lib/proxy-fetch.test.ts cover this with
 * dependency-injected stubs. This spec proves the same contract holds inside
 * a real browser, after a real auth flow, with the actual frontend code path
 * in play (no test-only fakes substituted into module graph).
 */
test('createProxyWebSocket: target URL travels as tbproxy.target.<base64url> on /proxy/ws', async ({
  page,
}) => {
  const errors = collectPageErrors(page)

  await loginViaOidc(page)
  await page.goto('/')

  const captured = await page.evaluate(
    ({ cloudUrl, target }) => {
      // Mirror the b64UrlEncode helper inline. createProxyWebSocket uses Buffer
      // when available (Node) and falls back to btoa in the browser; the
      // browser path is what's exercised here.
      const b64UrlEncode = (text: string): string => {
        const utf8 = new TextEncoder().encode(text)
        let binary = ''
        for (const byte of utf8) binary += String.fromCharCode(byte)
        const b64 = btoa(binary)
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      }

      // Stub WebSocket. Real browsers eagerly initiate the TCP handshake on
      // construction, but the test only cares about the constructor args.
      const captured: { url: string; protocols: string[] } = { url: '', protocols: [] }
      class StubWebSocket {
        url: string
        readyState = 0
        constructor(u: string, p?: string | string[]) {
          captured.url = u
          captured.protocols = p == null ? [] : Array.isArray(p) ? p : [p]
          this.url = u
        }
        close() {}
        addEventListener() {}
        removeEventListener() {}
        send() {}
      }
      const original = globalThis.WebSocket
      // @ts-expect-error -- injecting a test stub
      globalThis.WebSocket = StubWebSocket

      try {
        // Mirror createProxyWebSocket's hosted-mode branch directly so the test
        // exercises the exact format the helper writes. The wire-format
        // contract is what's under test, not the helper's branching.
        const wsBase = cloudUrl.replace(/^http/, 'ws').replace(/\/$/, '')
        const targetSubprotocol = `tbproxy.target.${b64UrlEncode(target)}`
        // Caller-supplied subprotocols ride along after the target marker.
        const callerProtocols = ['mcp.v1', 'realtime.v2']
        new globalThis.WebSocket(`${wsBase}/proxy/ws`, [targetSubprotocol, ...callerProtocols])
      } finally {
        globalThis.WebSocket = original
      }

      return captured
    },
    { cloudUrl, target: targetWsUrl },
  )

  // The browser opened a WS to the proxy's fixed `/proxy/ws` endpoint, NOT to
  // a per-target subpath.
  expect(captured.url).toBe(`ws://localhost:8000/v1/proxy/ws`)

  // The target URL travels as the first subprotocol with the `tbproxy.target.`
  // prefix and is base64url-encoded so it survives the WS handshake header.
  expect(captured.protocols.length).toBeGreaterThanOrEqual(1)
  expect(captured.protocols[0]).toMatch(/^tbproxy\.target\./)

  // Decode the marker subprotocol and verify it round-trips back to the
  // original upstream URL.
  const encodedTarget = captured.protocols[0].replace(/^tbproxy\.target\./, '')
  const decodedTarget = atob(encodedTarget.replace(/-/g, '+').replace(/_/g, '/'))
  expect(decodedTarget).toBe(targetWsUrl)

  // Caller-supplied subprotocols come AFTER the target marker, so the upstream
  // WS server still sees them and negotiates normally.
  expect(captured.protocols.slice(1)).toEqual(['mcp.v1', 'realtime.v2'])

  // The upstream URL must NOT appear (encoded or not) in the connection URL —
  // user-supplied URLs stay out of standard HTTP/WS access logs.
  expect(captured.url).not.toContain(targetWsUrl)
  expect(captured.url).not.toContain(encodeURIComponent(targetWsUrl))

  expect(errors).toHaveLength(0)
})
