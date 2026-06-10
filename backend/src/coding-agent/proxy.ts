/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A thin bidirectional bridge between a connected Thunderbolt client socket and
 * the workspace shim's ACP WebSocket. Unlike the Haystack server (which
 * translates ACP↔HTTP), our agent is already a complete ACP endpoint, so this
 * just pipes raw frames both ways. Client→upstream frames that arrive before the
 * upstream finishes connecting are buffered and flushed in order on open.
 */

const wsOpen = 1

/** Minimal surface of a client WebSocket the proxy needs (Bun/global WebSocket). */
export type UpstreamSocket = {
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener: (
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ) => void
}

export type UpstreamFactory = (url: string) => UpstreamSocket

export type CodingAgentProxyDeps = {
  /** Send a frame down to the connected Thunderbolt client. */
  send: (data: string) => void
  /** Invoked when the upstream closes or errors, so the route can close the client socket. */
  onUpstreamClose: (code: number, reason: string) => void
  /** Workspace shim ACP endpoint (may carry the shim token as a query param). */
  upstreamUrl: string
  /** Injectable upstream factory; defaults to the global WebSocket. */
  createUpstream?: UpstreamFactory
}

const defaultFactory: UpstreamFactory = (url) => new WebSocket(url) as unknown as UpstreamSocket

/**
 * Bridge one client connection to the workspace shim. Construct after auth +
 * provisioning succeed; feed client frames via {@link handleClientMessage} and
 * tear down with {@link dispose}.
 */
export class CodingAgentProxy {
  private readonly upstream: UpstreamSocket
  private readonly pending: string[] = []
  private upstreamOpen = false
  private disposed = false

  constructor(private readonly deps: CodingAgentProxyDeps) {
    const factory = deps.createUpstream ?? defaultFactory
    this.upstream = factory(deps.upstreamUrl)

    this.upstream.addEventListener('open', () => {
      this.upstreamOpen = true
      for (const frame of this.pending) {
        this.upstream.send(frame)
      }
      this.pending.length = 0
    })
    this.upstream.addEventListener('message', (event) => {
      const data = event.data
      this.deps.send(typeof data === 'string' ? data : JSON.stringify(data))
    })
    this.upstream.addEventListener('close', (event) => {
      if (!this.disposed) {
        this.deps.onUpstreamClose(event.code ?? 1006, event.reason ?? 'upstream closed')
      }
    })
    this.upstream.addEventListener('error', () => {
      if (!this.disposed) {
        this.deps.onUpstreamClose(1011, 'upstream error')
      }
    })
  }

  /** Forward a frame from the client to the workspace, buffering until upstream is open. */
  handleClientMessage(frame: string): void {
    if (this.upstreamOpen && this.upstream.readyState === wsOpen) {
      this.upstream.send(frame)
      return
    }
    this.pending.push(frame)
  }

  /** Close the upstream connection. Idempotent; suppresses the upstream-close callback. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.upstream.close(1000, 'client disconnected')
  }
}
