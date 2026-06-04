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
 *  tear the transport down (closes the WebSocket). */
export type AcpTransport = {
  stream: Stream
  close: () => void
  /** Resolves when the transport closes cleanly; REJECTS when it closes
   *  terminally (a non-reconnectable close code or exhausted reconnects) so the
   *  handshake can race against it and fail loudly instead of hanging on a
   *  pending `initialize`. Optional so simpler fake transports (tests) can omit
   *  it — the adapter only races when it's present. */
  closed?: Promise<void>
}

/** Inputs to `openTransport(...)`. WebSocket is the only remote transport;
 *  the factory honours the proxy toggle (native socket vs subprotocol tunnel). */
export type OpenTransportOptions = {
  url: string
  transport: 'websocket'
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
  | { type: 'message-metadata'; messageMetadata: Record<string, unknown> }
  | { type: 'finish-step' }
  | { type: 'finish' }
  | { type: 'error'; errorText: string }
