/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import type { HttpClient } from '@/contexts'

/** The slice of the authenticated app client the enrollment calls need. Narrowed to
 *  `post` so tests can pass a tiny fake instead of a whole HttpClient (DI over module
 *  mocking). The real client attaches the bearer token + X-Device-ID automatically. */
type EnrollClient = Pick<HttpClient, 'post'>

/** The bridge being added, as the user typed it: the ticket / bare NodeId the transport
 *  dials, plus the human name shown in the devices list. Also the shape the add-page
 *  enrollment DI seams pass, so they stay in lockstep with {@link enrollIrohBridge}. */
export type IrohBridge = {
  /** The `EndpointTicket` or bare NodeId held in the agent/server `url` — the exact
   *  string the iroh transport dials. Passed to the backend unparsed (see
   *  {@link enrollIrohBridge}). */
  target: string
  /** Human name for the bridge device (the agent/server name). */
  name: string
}

/**
 * Self-enroll THIS app's iroh dialer NodeId into the account's device allowlist, so a
 * same-account bridge auto-allows it without the user ever running
 * `thunderbolt iroh allow <node-id>` (design decision D4).
 *
 * Writes the caller's OWN `node_id` via the lightweight self-enroll route
 * (`POST /devices/me/node-id`, no canary): proof-of-possession happens at the iroh QUIC
 * handshake on connect, so declaring a NodeId you can't dial as grants nothing. The route
 * pins the write to the session's bound device, so this can only enroll the app itself.
 *
 * This is a transparent side-effect of adding an iroh ACP agent or MCP bridge. It is
 * optimistic and throwing on purpose: callers run it best-effort and, on failure
 * (Standalone / no account / offline), fall back to the manual `thunderbolt iroh allow`
 * one-liner still shown in the add dialog. Enrollment must never block the add.
 *
 * @param httpClient Authenticated app client (bearer + X-Device-ID attached by the client).
 * @param loadNodeId Test/DI seam for reading this app's NodeId; production lazy-loads the wasm.
 */
export const selfEnrollIrohNodeId = async (
  httpClient: EnrollClient,
  loadNodeId: () => Promise<string> = irohClientNodeId,
): Promise<void> => {
  const nodeId = await loadNodeId()
  await httpClient.post('devices/me/node-id', { json: { nodeId } })
}

/**
 * Transparent same-account enrollment (design decision D4) fired when the user adds an
 * iroh ACP agent or MCP-via-bridge in the app. Two writes, in order:
 *
 * 1. **Self-enroll this app's dialer NodeId** ({@link selfEnrollIrohNodeId}) so a
 *    same-account bridge auto-allows it — the write that actually grants access.
 * 2. **Register the bridge itself** as a `device_type='bridge'` device via
 *    `POST /devices/bridge`, so it appears in the devices list (badge) and is revocable.
 *    `device_type` is server-managed (deny-listed from PowerSync upload), so a bridge can
 *    only be created through this backend route, never raw sync.
 *
 * The bridge's `target` (the ticket / bare NodeId the transport dials) is sent to the
 * backend **unparsed** — the browser has no iroh ticket parser and the wasm client dials
 * either form as-is, so the transport does no parsing either. The stored `node_id` is only
 * ever read back as the account allowlist (harmless: no peer can dial as the bridge's key
 * without its ed25519 private key), so passing the ticket through grants nothing extra.
 *
 * Optimistic and throwing on purpose: callers run it best-effort and, on any failure
 * (Standalone / no account / offline), fall back to the manual `thunderbolt iroh allow`
 * one-liner shown in the add dialog. Enrollment must never block the add. Step 2 runs only
 * after step 1 succeeds — a failed self-enroll skips the (now pointless) bridge write.
 *
 * @param httpClient Authenticated app client (bearer + X-Device-ID attached by the client).
 * @param bridge The iroh target + name of the bridge being added.
 * @param loadNodeId Test/DI seam for reading this app's NodeId; production lazy-loads the wasm.
 */
export const enrollIrohBridge = async (
  httpClient: EnrollClient,
  bridge: IrohBridge,
  loadNodeId: () => Promise<string> = irohClientNodeId,
): Promise<void> => {
  await selfEnrollIrohNodeId(httpClient, loadNodeId)
  await httpClient.post('devices/bridge', { json: { nodeId: bridge.target.trim(), name: bridge.name } })
}
