/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import type { HttpClient } from '@/contexts'

/** The slice of the authenticated app client the enrollment calls need. Narrowed to
 *  `post` so tests can pass a tiny fake instead of a whole HttpClient (DI over module
 *  mocking). The real client attaches the bearer token + X-Device-ID automatically. */
type EnrollClient = Pick<HttpClient, 'post'>

/**
 * Self-enroll THIS app's iroh dialer NodeId into the account's device allowlist when an
 * iroh ACP agent or MCP bridge is added, so a same-account bridge auto-allows it without
 * the user running `thunderbolt iroh allow <node-id>`.
 *
 * Writes the caller's OWN `node_id` via the lightweight self-enroll route
 * (`POST /devices/me/node-id`, no canary): proof-of-possession happens at the iroh QUIC
 * handshake on connect, so declaring a NodeId you can't dial as grants nothing. The route
 * pins the write to the session's bound device, so this can only enroll the app itself.
 *
 * The bridge registers its own bare NodeId with the backend at boot through
 * `POST /devices/bridge`. The app must not register the user-entered dial target because it
 * may be a full EndpointTicket rather than a bare NodeId.
 *
 * Optimistic and throwing on purpose: callers run this best-effort and, on failure
 * (Standalone / no account / offline), fall back to the manual pairing command still shown
 * in the add dialog. Enrollment must never block the add.
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
