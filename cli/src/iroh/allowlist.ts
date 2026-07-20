/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Peer allowlist for the iroh bridge — the authorization gate for the transport.
 *
 * Because an iroh NodeId is an ed25519 public key, the QUIC handshake already
 * authenticates *who* a peer is for free; this list decides *whether* that peer
 * may drive a local agent. Only NodeIds present here are permitted to open a
 * bridged session. Stored one NodeId per line at `~/.thunderbolt/iroh/allowlist`.
 */

import { irohDir, allowlistPath } from './paths.ts'
import { readFileOrNull, writeSecureFile } from '../lib/secure-fs.ts'

/**
 * The current allowlist as an ordered, de-duplicated list of NodeId strings.
 * An absent file yields an empty list (no peer is trusted by default).
 */
export const list = async (): Promise<string[]> => {
  const raw = await readFileOrNull(allowlistPath())
  if (raw === null) return []
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    const id = line.trim()
    if (id) seen.add(id)
  }
  return [...seen]
}

/** Whether `nodeId` is permitted to open a bridged session. */
export const isAllowed = async (nodeId: string): Promise<boolean> => {
  const ids = await list()
  return ids.includes(nodeId.trim())
}

/**
 * Add a NodeId to the allowlist (idempotent). Returns `true` if it was newly
 * added, `false` if it was already present.
 *
 * @param nodeId - the peer NodeId (base32) to trust
 */
export const add = async (nodeId: string): Promise<boolean> => {
  const id = nodeId.trim()
  const ids = await list()
  if (ids.includes(id)) return false
  await writeSecureFile(irohDir(), allowlistPath(), [...ids, id].join('\n') + '\n')
  return true
}
