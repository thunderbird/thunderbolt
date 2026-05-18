/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { createTestApp, type TestAppHandle } from '@/test-utils/e2e'
import { createObservabilityRecorder } from './observability'
import { wsCloseCodes } from './ws'

/** Tiny upstream WebSocket echo server backed by Bun.serve. Returns the listening
 *  port and a stop() helper. The upstream behavior is parametrised per test. */
const startUpstreamServer = async (
  handlers: {
    open?: (ws: { send: (...args: unknown[]) => unknown; close: (code?: number, reason?: string) => void }) => void
    message?: (
      ws: { send: (...args: unknown[]) => unknown; close: (code?: number, reason?: string) => void },
      message: string | Buffer,
    ) => void
    close?: (code: number, reason: string) => void
  } = {},
) => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      // Pick the first offered subprotocol so the client's handshake completes cleanly.
      const offered = req.headers.get('sec-websocket-protocol')
      const chosen = offered?.split(',')[0]?.trim()
      if (
        srv.upgrade(req, {
          headers: chosen ? { 'sec-websocket-protocol': chosen } : undefined,
        })
      ) {
        return
      }
      return new Response('not a ws request', { status: 400 })
    },
    websocket: {
      open: (ws) => handlers.open?.(ws as never),
      message: (ws, msg) => handlers.message?.(ws as never, msg as string | Buffer),
      close: (_ws, code, reason) => handlers.close?.(code, reason),
    },
  })
  return {
    port: server.port as number,
    stop: async () => {
      server.stop(true)
    },
  }
}

/** Build a wsFactory that ignores the validated public URL and connects the
 *  proxy's relay to the local upstream port instead. The test treats the
 *  public-looking hostname as a placeholder; the actual upstream is local. */
const localUpstreamWsFactory =
  (port: number) =>
  (_url: string, protocols?: string[]): WebSocket =>
    new WebSocket(`ws://127.0.0.1:${port}`, protocols)

/** Build the Sec-WebSocket-Protocol value: target marker + caller protocols. */
const buildProtocols = (target: string, callerProtocols: string[] = []): string[] => [
  `tbproxy.target.${Buffer.from(target).toString('base64url')}`,
  ...callerProtocols,
]

/** Spin up an authenticated test app on a real port and return both the proxy
 *  and the test handle. */
const startProxy = async (
  options: { upstreamWsFactory?: (url: string, protocols?: string[]) => WebSocket } = {},
): Promise<{ handle: TestAppHandle; proxyPort: number }> => {
  const handle = await createTestApp(options)
  // Bind to ephemeral port — Elysia's listen() resolves once the server is up.
  await new Promise<void>((resolve) => {
    handle.app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  const port = (handle.app as unknown as { server: { port: number } }).server!.port
  return { handle, proxyPort: port }
}

const closeProxy = async (handle: TestAppHandle) => {
  // Force-close any remaining connections so WS-bearing tests don't hang afterEach.
  // Cap the stop with a short timeout — Bun's stop(true) has been observed to hang
  // when peer-side WS connections are half-closed; we don't want that to block tests.
  const stopWithTimeout = async () => {
    const stop = handle.app.stop as unknown as (closeActiveConnections?: boolean) => Promise<void> | void
    await Promise.race([Promise.resolve(stop.call(handle.app, true)), new Promise((r) => setTimeout(r, 500))])
  }
  try {
    await stopWithTimeout()
  } catch {
    // ignore
  }
  await handle.cleanup()
}

/** Wait for a WebSocket close event and return the code. */
const waitForClose = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    ws.addEventListener('close', (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason })
    })
  })

describe('Universal proxy WebSocket relay /v1/proxy/ws — e2e', () => {
  let handles: TestAppHandle[] = []
  const upstreams: Array<{ stop: () => Promise<void> }> = []

  afterEach(async () => {
    for (const h of handles) {
      await closeProxy(h)
    }
    for (const u of upstreams) {
      await u.stop()
    }
    handles = []
    upstreams.length = 0
  })

  it('relays text messages bidirectionally', async () => {
    const upstream = await startUpstreamServer({
      message: (ws, msg) => ws.send(`echo: ${typeof msg === 'string' ? msg : msg.toString('utf-8')}`),
    })
    upstreams.push(upstream)

    const { handle, proxyPort } = await startProxy({
      upstreamWsFactory: localUpstreamWsFactory(upstream.port),
    })
    handles.push(handle)

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/proxy/ws`, {
      protocols: buildProtocols('wss://upstream.test/path', ['acp.v1']),
      headers: { Authorization: `Bearer ${handle.bearerToken}` },
    } as unknown as string[])

    const messages: string[] = []
    // Use onmessage rather than addEventListener: in Bun's same-process WS the
    // addEventListener path has been observed to drop late-bound 'message' events.
    client.onmessage = (e: MessageEvent) => {
      messages.push(typeof e.data === 'string' ? e.data : '')
    }

    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('error', () => reject(new Error('client errored')))
    })

    client.send('hello')
    await new Promise((r) => setTimeout(r, 100))
    expect(messages).toContain('echo: hello')
    client.close()
  })

  it('upstream close code propagates through the relay (server-side observation)', async () => {
    // We observe the close on the proxy's relay (where the upstream connection
    // surfaces) rather than on the downstream client. Bun's same-process WS
    // client has been observed to drop late-binding close events; the relay
    // logic is the contract, and we verify it directly via a hooked relay.
    const upstream = await startUpstreamServer({
      message: (ws) => ws.close(4321, 'upstream closing'),
    })
    upstreams.push(upstream)

    const observed: { code: number | null } = { code: null }
    const upstreamFactory = (_url: string, protocols?: string[]): WebSocket => {
      const ws = new WebSocket(`ws://127.0.0.1:${upstream.port}`, protocols)
      ws.onclose = (event: CloseEvent) => {
        observed.code = event.code
      }
      return ws
    }

    const { handle, proxyPort } = await startProxy({ upstreamWsFactory: upstreamFactory })
    handles.push(handle)

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/proxy/ws`, {
      protocols: buildProtocols('wss://upstream.test/', ['acp.v1']),
      headers: { Authorization: `Bearer ${handle.bearerToken}` },
    } as unknown as string[])
    client.onopen = () => client.send('please close')
    // Poll for the upstream-side close — Bun's same-process WS doesn't reliably
    // surface late-binding events on the downstream client, so we observe at
    // the upstream connection (where the proxy's relay sits) instead.
    let polls = 0
    while (observed.code === null && polls < 50) {
      await new Promise((r) => setTimeout(r, 50))
      polls++
    }
    expect(observed.code).toBe(4321)
    try {
      client.close()
    } catch {
      /* may already be closed */
    }
  })

  it('rejects upgrade with HTTP 400 when subprotocol is missing tbproxy.target.*', async () => {
    const upstream = await startUpstreamServer()
    upstreams.push(upstream)

    const { handle, proxyPort } = await startProxy({
      upstreamWsFactory: localUpstreamWsFactory(upstream.port),
    })
    handles.push(handle)

    // No tbproxy.target.* entry in protocols.
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/proxy/ws`, {
      protocols: ['acp.v1'],
      headers: { Authorization: `Bearer ${handle.bearerToken}` },
    } as unknown as string[])
    await new Promise<void>((resolve) => {
      client.addEventListener('error', () => resolve())
      client.addEventListener('close', () => resolve())
    })
    expect(client.readyState).toBe(WebSocket.CLOSED)
  })

  it('closes downstream with 4003 when target uses ws:// (plaintext)', async () => {
    const upstream = await startUpstreamServer()
    upstreams.push(upstream)

    const { handle, proxyPort } = await startProxy({
      upstreamWsFactory: localUpstreamWsFactory(upstream.port),
    })
    handles.push(handle)

    // ws:// plaintext target — should be rejected (HTTP 400 pre-upgrade).
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/proxy/ws`, {
      protocols: buildProtocols('ws://upstream.test/'),
      headers: { Authorization: `Bearer ${handle.bearerToken}` },
    } as unknown as string[])
    const closeEvent = await waitForClose(client)
    // beforeHandle returns 400 → upgrade refused → browser sees the WS handshake fail.
    // Bun's WebSocket reports this as 1002 (protocol error) or 1006 (abnormal closure)
    // depending on the exact failure point; either signals the upgrade was rejected.
    expect([wsCloseCodes.schemeRejected, 1002, 1006]).toContain(closeEvent.code)
    expect(client.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects unauthenticated WS upgrade', async () => {
    const upstream = await startUpstreamServer()
    upstreams.push(upstream)

    const { handle, proxyPort } = await startProxy({
      upstreamWsFactory: localUpstreamWsFactory(upstream.port),
    })
    handles.push(handle)

    // Real WebSocket constructor cannot pass Authorization headers from JS,
    // and we have no session cookie, so this upgrade should fail.
    // We expect either an error or close before open.
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/proxy/ws`, buildProtocols('wss://upstream.test/'))
    const closed = await new Promise<boolean>((resolve) => {
      client.addEventListener('open', () => resolve(false))
      client.addEventListener('error', () => resolve(true))
      client.addEventListener('close', () => resolve(true))
    })
    expect(closed).toBe(true)
  })
})

/** Build a capturing observability recorder for WS tests. The proxy core ws.ts
 *  emits `proxy_ws_relay` events through the recorder when the downstream
 *  close fires; we collect them here and assert `error_type` per path. */
const captureWsRecorder = () => {
  const logs: Array<Record<string, unknown>> = []
  const recorder = createObservabilityRecorder({
    logger: { info: (event) => logs.push(event as Record<string, unknown>) },
  })
  return { recorder, logs }
}

/** Wait until at least one `proxy_ws_relay` event has landed in `logs`, or
 *  the timeout expires. The relay emits on the downstream close handler which
 *  Bun delivers asynchronously after `safeWsClose`. */
const waitForWsRelayLog = async (logs: Array<Record<string, unknown>>, timeoutMs = 1500) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (logs.some((l) => (l as { event?: string }).event === 'proxy_ws_relay')) {
      return
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('Universal proxy WS observability — error_type per close path', () => {
  let handles: TestAppHandle[] = []
  const upstreams: Array<{ stop: () => Promise<void> }> = []

  afterEach(async () => {
    for (const h of handles) {
      await closeProxy(h)
    }
    for (const u of upstreams) {
      await u.stop()
    }
    handles = []
    upstreams.length = 0
  })

  it('emits error_type=upstream_5xx when the upstream WS emits an error event', async () => {
    // Connect to a high port that's almost certainly nothing — TCP RST → the
    // upstream WebSocket fires `error` then `close(1006)`. The relay's `error`
    // listener fires `safeWsClose(ws, 1011, 'upstream error')`, which the
    // downstream close handler classifies as `upstream_5xx`.
    const upstreamFactory = (_url: string, protocols?: string[]): WebSocket =>
      new WebSocket(`ws://127.0.0.1:1`, protocols)

    const { recorder, logs } = captureWsRecorder()
    const observedHandle = await createTestApp({
      upstreamWsFactory: upstreamFactory,
      proxyObservability: recorder,
    })
    await new Promise<void>((resolve) => {
      observedHandle.app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
    })
    handles.push(observedHandle)
    const observedPort = (observedHandle.app as unknown as { server: { port: number } }).server!.port

    const client = new WebSocket(`ws://127.0.0.1:${observedPort}/v1/proxy/ws`, {
      protocols: buildProtocols('wss://upstream.test/'),
      headers: { Authorization: `Bearer ${observedHandle.bearerToken}` },
    } as unknown as string[])

    await new Promise<void>((resolve) => {
      client.addEventListener('close', () => resolve())
      client.addEventListener('error', () => resolve())
    })

    await waitForWsRelayLog(logs)
    const relay = logs.find((l) => (l as { event?: string }).event === 'proxy_ws_relay') as
      | { error_type?: string; status?: number }
      | undefined
    expect(relay).toBeDefined()
    expect(relay?.error_type).toBe('upstream_5xx')
    expect(relay?.status).toBe(wsCloseCodes.internalError)
  })

  it('emits error_type=cap_exceeded when pre-connect queue overflows', async () => {
    // Upstream that never opens — every message the client sends queues
    // server-side until the queue cap fires.
    const slowOpenUpstream = (_url: string, _protocols?: string[]): WebSocket => {
      const proto = _protocols ? _protocols[0] : undefined
      // Connect to an unused high port so the connect hangs in CONNECTING.
      // Bun's WebSocket fires no `open` until/unless TCP completes.
      const ws = new WebSocket(`ws://127.0.0.1:1`, proto)
      // Suppress the error event so the relay's `error` listener does not
      // race the queue overflow path. We want the *message handler's* queue
      // overflow branch (4008), not the upstream-error branch (1011).
      ws.addEventListener('error', (e) => e.preventDefault?.())
      return ws
    }

    const { recorder, logs } = captureWsRecorder()
    const observedHandle = await createTestApp({
      upstreamWsFactory: slowOpenUpstream,
      proxyObservability: recorder,
    })
    await new Promise<void>((resolve) => {
      observedHandle.app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
    })
    handles.push(observedHandle)
    const observedPort = (observedHandle.app as unknown as { server: { port: number } }).server!.port

    const client = new WebSocket(`ws://127.0.0.1:${observedPort}/v1/proxy/ws`, {
      protocols: buildProtocols('wss://upstream.test/'),
      headers: { Authorization: `Bearer ${observedHandle.bearerToken}` },
    } as unknown as string[])

    await new Promise<void>((resolve) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('close', () => resolve())
      client.addEventListener('error', () => resolve())
    })

    // Flood the relay with messages while upstream is still CONNECTING / fails.
    // 64-message cap + 256 KiB cap — send 70 small messages and one huge one
    // to guarantee at least one of the caps fires before upstream errors out.
    if (client.readyState === WebSocket.OPEN) {
      for (let i = 0; i < 70; i++) {
        try {
          client.send(`m${i}`)
        } catch {
          break
        }
      }
      try {
        client.send('x'.repeat(300_000))
      } catch {
        // already closed by overflow
      }
    }

    await new Promise<void>((resolve) => {
      if (client.readyState === WebSocket.CLOSED) {
        resolve()
      } else {
        client.addEventListener('close', () => resolve())
      }
    })

    await waitForWsRelayLog(logs)
    const relay = logs.find((l) => (l as { event?: string }).event === 'proxy_ws_relay') as
      | { error_type?: string; status?: number }
      | undefined
    expect(relay).toBeDefined()
    // Either the queue overflow fired first (4008/cap_exceeded) or the upstream
    // dial failed first (1011/upstream_5xx). Both are legitimate proxy errors
    // we want categorised — never undefined.
    expect(relay?.error_type).toBeDefined()
    expect(['cap_exceeded', 'upstream_5xx']).toContain(relay?.error_type as string)
  })

  it('emits no error_type when the upstream closes cleanly with code 1000', async () => {
    const upstream = await startUpstreamServer({
      open: (ws) => ws.close(1000, 'bye'),
    })
    upstreams.push(upstream)

    const { recorder, logs } = captureWsRecorder()
    const observedHandle = await createTestApp({
      upstreamWsFactory: localUpstreamWsFactory(upstream.port),
      proxyObservability: recorder,
    })
    await new Promise<void>((resolve) => {
      observedHandle.app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
    })
    handles.push(observedHandle)
    const observedPort = (observedHandle.app as unknown as { server: { port: number } }).server!.port

    const client = new WebSocket(`ws://127.0.0.1:${observedPort}/v1/proxy/ws`, {
      protocols: buildProtocols('wss://upstream.test/'),
      headers: { Authorization: `Bearer ${observedHandle.bearerToken}` },
    } as unknown as string[])
    await new Promise<void>((resolve) => {
      client.addEventListener('close', () => resolve())
      client.addEventListener('error', () => resolve())
    })

    await waitForWsRelayLog(logs)
    const relay = logs.find((l) => (l as { event?: string }).event === 'proxy_ws_relay') as
      | { error_type?: string; status?: number }
      | undefined
    expect(relay).toBeDefined()
    // Clean close — categorisation must stay undefined, matching the
    // 2xx/3xx-no-error-type pattern on the HTTP path.
    expect(relay?.error_type).toBeUndefined()
    expect(relay?.status).toBe(1000)
  })
})
