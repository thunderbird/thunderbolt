/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared detector for an iroh dial target — used by BOTH the ACP custom-agent
 * dialog and the MCP add-server form so a single rule decides what routes to the
 * peer-to-peer iroh transport.
 *
 * A bare iroh NodeId is an ed25519 public key as 52 lowercase base32 chars; an
 * EndpointTicket shares that alphabet but is longer (it embeds the NodeId, home
 * relay, and direct addresses). Neither contains the `:`/`/`/`.` of a `ws(s)://`
 * or `http(s)://` URL, so any single lowercase-base32 token of NodeId length or
 * longer is an iroh target. The wasm client is the source of truth on dial; this
 * is a cheap router that keeps URL-shaped inputs (http/sse/ws) out of the iroh
 * branch.
 */
const irohTargetPattern = /^[a-z2-7]{52,}$/

/** True when `value` is a bare iroh NodeId or an EndpointTicket (lowercase base32,
 *  NodeId length or longer). Expects an already-trimmed token. */
export const isIrohTarget = (value: string): boolean => irohTargetPattern.test(value)
