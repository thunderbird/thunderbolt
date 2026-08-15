/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Backend ACP frame relay: pipes a browser WebSocket to the sandbox's ACP-WS
 * endpoint. It never parses ACP — each message is one JSON-RPC object (the same
 * one-object-per-frame contract the sandbox shim and Thunderbolt's transport
 * both use), so the relay is a dumb, version-proof pipe.
 *
 * This is the managed-acp equivalent of Haystack's in-backend ACP server: there
 * the backend *is* the agent; here the backend just forwards to the per-user
 * sandbox that runs the real agent.
 */

/** Minimal upstream socket surface — lets tests inject a fake without a real WS. */
export type UpstreamSocket = {
  readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (type: 'open' | 'message' | 'close', listener: (event: { data?: unknown }) => void) => void
}

export type SandboxRelay = {
  /** Forward a frame from the browser to the sandbox (queued until upstream opens). */
  fromBrowser: (data: string) => void
  /** Tear down the upstream connection. */
  close: () => void
}

const readyStateOpen = 1

/**
 * Open a relay to `targetUrl` (the sandbox ACP-WS endpoint). `toBrowser` is
 * called with each frame the sandbox emits; `onUpstreamClose` fires when the
 * sandbox side drops so the caller can close the browser socket too.
 */
export const createSandboxRelay = (
  targetUrl: string,
  toBrowser: (data: string) => void,
  onUpstreamClose: () => void,
  deps: { connect?: (url: string) => UpstreamSocket } = {},
): SandboxRelay => {
  const connect = deps.connect ?? ((url) => new WebSocket(url) as unknown as UpstreamSocket)
  const upstream = connect(targetUrl)
  const queue: string[] = []
  let open = false

  upstream.addEventListener('open', () => {
    open = true
    for (const msg of queue) {
      upstream.send(msg)
    }
    queue.length = 0
  })
  upstream.addEventListener('message', (event) => {
    toBrowser(typeof event.data === 'string' ? event.data : String(event.data))
  })
  upstream.addEventListener('close', () => {
    onUpstreamClose()
  })

  return {
    fromBrowser: (data) => {
      if (open && upstream.readyState === readyStateOpen) {
        upstream.send(data)
        return
      }
      queue.push(data)
    },
    close: () => {
      try {
        upstream.close()
      } catch {
        // already closed
      }
    },
  }
}
