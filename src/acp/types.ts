/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Internal types for the ACP client library.
 *
 * The public adapter contracts (`Agent`, `AgentAdapter`, `AgentAdapterContext`,
 * `AgentCapabilities`) live in `src/types/acp.ts` and are re-exported through
 * `index.ts`. This file holds the transport seam types — anything specific to
 * how `acpAdapter` talks to a `ClientSideConnection` — so the public surface
 * stays small and the wire types stay flat.
 */

import type { Stream } from '@agentclientprotocol/sdk'

/** Bidirectional ACP message stream + a lifecycle hook the adapter calls to
 *  tear the transport down (closes the WebSocket, cancels the SSE request). */
export type AcpTransport = {
  stream: Stream
  close: () => void
}

/** Event payload from the Tauri Rust HTTP+SSE command. Mirrors `AcpHttpEvent`
 *  declared in `src/lib/tauri-acp-http.ts` (M5 owns the runtime). Kept here so
 *  the HTTP transport compiles before M5 lands. M5's wrapper re-exports its
 *  own definitions; the shapes MUST match. */
export type AcpHttpEvent =
  | { type: 'headers'; status: number }
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; message: string }

export type AcpHttpHandle = {
  cancel: () => Promise<void>
}

export type AcpHttpSseRequestFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  onEvent: (event: AcpHttpEvent) => void,
) => Promise<AcpHttpHandle>

/** Inputs to `openTransport(...)`. The factory dispatches to ws or http-sse
 *  based on `agent.transport`; both branches honour the proxy toggle. */
export type OpenTransportOptions = {
  url: string
  transport: 'websocket' | 'http'
  /** AbortSignal that, when aborted, must close the transport and cancel any
   *  in-flight retries. The adapter owns this controller and aborts on
   *  `disconnect()`. */
  signal: AbortSignal
}

/** Minimal AI SDK v5 UI message stream chunk shapes the translator emits.
 *  We mirror the spec from `ai`'s `UIMessageChunk` union but only declare the
 *  variants we produce so type-changes upstream surface as compile errors. */
export type AiSdkChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'tool-input-start'
      toolCallId: string
      toolName: string
      title?: string
    }
  | {
      type: 'tool-input-available'
      toolCallId: string
      toolName: string
      input: unknown
      title?: string
    }
  | {
      type: 'tool-output-available'
      toolCallId: string
      output: unknown
    }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'finish-step' }
  | { type: 'finish' }
  | { type: 'error'; errorText: string }
