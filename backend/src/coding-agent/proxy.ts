/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A thin bidirectional bridge between a connected Thunderbolt client socket and
 * the workspace shim's ACP WebSocket. Our agent is already a complete ACP
 * endpoint, so this just pipes raw frames both ways. Client→upstream frames that
 * arrive before the upstream finishes connecting are buffered (bounded) and
 * flushed in order on open. Mirrors the discipline of the universal relay in
 * `backend/src/proxy/ws.ts`: a single `closing` flag guards every listener, the
 * pre-connect queue is capped, a connect timeout bounds a hung upstream, and the
 * upstream-provided close reason is never relayed to the client.
 */

const wsReadyStateOpen = 1

const defaultConnectTimeoutMs = 10_000
const defaultQueueBytes = 256 * 1024
const defaultQueueMessages = 64

/** Upstream error / abnormal close reported to the client (RFC 6455 1011). */
const wsCloseUpstreamError = 1011
/** Pre-connect queue exceeded its byte/message budget (app range). */
const wsCloseQueueOverflow = 4008

export type UpstreamEvent = { data?: unknown; code?: number; reason?: string }

/** Minimal surface of a client WebSocket the proxy needs (Bun/global WebSocket). */
export type UpstreamSocket = {
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  // `type` is a literal union so an event-name typo is a compile error.
  addEventListener: (type: 'open' | 'message' | 'close' | 'error', listener: (event: UpstreamEvent) => void) => void
}

export type UpstreamFactory = (url: string) => UpstreamSocket

export type CodingAgentProxyDeps = {
  /** Send a frame down to the connected Thunderbolt client. */
  send: (data: string) => void
  /** Tear down the client socket with this code + a (generic, leak-safe) reason. */
  onClose: (code: number, reason: string) => void
  /** Server-side structured logging hook (real upstream code/reason go here, never to the client). */
  onLog?: (event: string, detail: Record<string, unknown>) => void
  /** Workspace shim ACP endpoint (may carry the shim token as a query param). */
  upstreamUrl: string
  /** Injectable upstream factory; defaults to the global WebSocket. May throw (caller wraps). */
  createUpstream?: UpstreamFactory
  connectTimeoutMs?: number
  queueBytes?: number
  queueMessages?: number
  /** Injectable timers (tests); default to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const defaultFactory: UpstreamFactory = (url) => new WebSocket(url) as unknown as UpstreamSocket

/**
 * Bridge one client connection to the workspace shim. Construct after auth +
 * provisioning succeed; feed client frames via {@link handleClientMessage} and
 * tear down with {@link dispose}. The constructor opens the upstream socket and
 * may throw synchronously (invalid URL) — the caller must wrap construction.
 */
export class CodingAgentProxy {
  private readonly upstream: UpstreamSocket
  private pending: string[] = []
  private pendingBytes = 0
  private upstreamReady = false
  private closing = false
  private readonly queueBytes: number
  private readonly queueMessages: number
  private readonly clearTimer: (handle: unknown) => void
  private connectTimer: unknown

  constructor(private readonly deps: CodingAgentProxyDeps) {
    const factory = deps.createUpstream ?? defaultFactory
    this.queueBytes = deps.queueBytes ?? defaultQueueBytes
    this.queueMessages = deps.queueMessages ?? defaultQueueMessages
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

    this.upstream = factory(deps.upstreamUrl)

    this.connectTimer = setTimer(() => {
      if (this.closing || this.upstreamReady) {
        return
      }
      this.deps.onLog?.('coding-agent upstream connect timeout', {})
      this.teardown(wsCloseUpstreamError, 'upstream unavailable')
    }, deps.connectTimeoutMs ?? defaultConnectTimeoutMs)

    this.upstream.addEventListener('open', () => {
      if (this.closing) {
        this.safeUpstreamClose(1000)
        return
      }
      this.upstreamReady = true
      this.clearConnectTimer()
      for (const frame of this.pending) {
        this.trySend(frame)
      }
      this.pending = []
      this.pendingBytes = 0
    })

    this.upstream.addEventListener('message', (event) => {
      if (this.closing) {
        return
      }
      const data = event.data
      this.deps.send(typeof data === 'string' ? data : JSON.stringify(data))
    })

    this.upstream.addEventListener('close', (event) => {
      if (this.closing) {
        return
      }
      this.closing = true
      this.clearConnectTimer()
      // Log the real upstream code/reason server-side; never relay the reason to the client.
      this.deps.onLog?.('coding-agent upstream closed', { code: event.code, reason: event.reason })
      this.deps.onClose(sendableCloseCode(event.code ?? wsCloseUpstreamError), 'upstream closed')
    })

    this.upstream.addEventListener('error', () => {
      if (this.closing) {
        return
      }
      this.closing = true
      this.clearConnectTimer()
      this.deps.onLog?.('coding-agent upstream error', {})
      this.deps.onClose(wsCloseUpstreamError, 'upstream error')
    })
  }

  /** Forward a frame from the client to the workspace, buffering (bounded) until upstream is open. */
  handleClientMessage(frame: string): void {
    if (this.closing) {
      return
    }
    if (this.upstreamReady && this.upstream.readyState === wsReadyStateOpen) {
      this.trySend(frame)
      return
    }
    const bytes = Buffer.byteLength(frame)
    if (this.pending.length + 1 > this.queueMessages || this.pendingBytes + bytes > this.queueBytes) {
      this.deps.onLog?.('coding-agent pre-connect queue overflow', {
        frames: this.pending.length,
        bytes: this.pendingBytes,
      })
      this.teardown(wsCloseQueueOverflow, 'pre-connect queue overflow')
      return
    }
    this.pending.push(frame)
    this.pendingBytes += bytes
  }

  /** Close the upstream. Idempotent; does NOT call onClose (the client is already gone). */
  dispose(): void {
    if (this.closing) {
      return
    }
    this.closing = true
    this.clearConnectTimer()
    this.safeUpstreamClose(1000, 'client disconnected')
  }

  /** Internal teardown that also closes the client (timeout / overflow). */
  private teardown(code: number, reason: string): void {
    if (this.closing) {
      return
    }
    this.closing = true
    this.clearConnectTimer()
    this.safeUpstreamClose(1000, reason)
    this.deps.onClose(code, reason)
  }

  private trySend(frame: string): void {
    try {
      this.upstream.send(frame)
    } catch {
      // upstream gone mid-send; the close/error listener will tear down.
    }
  }

  private safeUpstreamClose(code?: number, reason?: string): void {
    try {
      this.upstream.close(code, reason)
    } catch {
      // already closed
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      this.clearTimer(this.connectTimer)
      this.connectTimer = undefined
    }
  }
}

/** RFC 6455 reserved codes (1005/1006/1015) cannot be sent by an endpoint — substitute. */
const sendableCloseCode = (code: number): number =>
  code === 1005 || code === 1006 || code === 1015 ? wsCloseUpstreamError : code
