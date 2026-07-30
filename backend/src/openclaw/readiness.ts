/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ACP readiness probe for a sandbox. A sandbox reports as running (E2B) well
 * before the OpenClaw stack inside it answers ACP, so `status` must probe the
 * actual protocol, not just liveness — otherwise the first chat races a
 * not-yet-serving agent.
 *
 * A bare TCP/HTTP check isn't enough (E2B's host resolves before the shim
 * listens). So we do the real ACP `initialize` round-trip — the exact handshake
 * the client does first — and count ready only when a JSON-RPC reply comes back.
 */

/** One probe: resolves true iff an `initialize` reply arrives before `timeoutMs`. */
export const probeAcpReady = (wsUrl: string, timeoutMs = 4000): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false
    const ws = new WebSocket(wsUrl)
    const finish = (ready: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // already closing
      }
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
        }),
      )
    })
    ws.addEventListener('message', () => finish(true))
    ws.addEventListener('error', () => finish(false))
    ws.addEventListener('close', () => finish(false))
  })
