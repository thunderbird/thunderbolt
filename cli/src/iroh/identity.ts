/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Persistent node identity for the iroh transport.
 *
 * An iroh NodeId is the base32 form of a 32-byte ed25519 public key, so the
 * identity *is* the cryptographic peer credential: persisting the secret key
 * keeps this machine's NodeId stable across runs, which is what makes a peer
 * allowlist (and, later, device-binding into the E2E key hierarchy) meaningful.
 * Each bridge protocol gets its own identity file (see {@link identityPath}), so
 * the acp and mcp bridges publish distinct NodeIds. The secret is stored
 * hex-encoded under `~/.thunderbolt/iroh/` with 0600 permissions.
 */

import { SecretKey } from '@number0/iroh'
import type { BridgeProtocol } from '../agent/types.ts'
import { irohDir, identityPath } from './paths.ts'
import { enforceSecureFile, readFileOrNull, writeSecureFile } from '../lib/secure-fs.ts'

/** A loaded node identity: the raw secret-key bytes to pin onto an endpoint,
 *  plus the derived public NodeId (base32) to share and allowlist. */
export type IrohIdentity = {
  /** 32-byte ed25519 secret key, ready for `EndpointBuilder.secretKey`. */
  readonly secretKeyBytes: readonly number[]
  /** Base32 NodeId (the ed25519 public key) identifying this node to peers. */
  readonly nodeId: string
}

/** Derive the NodeId (base32-ish key string) from secret-key bytes. */
const nodeIdOf = (secretKeyBytes: readonly number[]): string =>
  SecretKey.fromBytes([...secretKeyBytes])
    .public()
    .toString()

/**
 * Load this machine's persisted node identity for a bridge protocol, generating
 * and saving a fresh one on first use. Each protocol has its own file so the acp
 * and mcp bridges publish distinct NodeIds. The secret is stored hex-encoded;
 * its file is forced to `0600` on every load so a key restored with lax
 * permissions self-heals.
 *
 * @param protocol - the bridge protocol whose identity to load
 * @returns the secret-key bytes and the derived NodeId
 */
export const loadOrCreateIdentity = async (protocol: BridgeProtocol): Promise<IrohIdentity> => {
  const path = identityPath(protocol)
  const existing = await readFileOrNull(path)
  if (existing !== null) {
    await enforceSecureFile(path)
    const secretKeyBytes = [...Buffer.from(existing.trim(), 'hex')]
    return { secretKeyBytes, nodeId: nodeIdOf(secretKeyBytes) }
  }

  const secretKeyBytes = SecretKey.generate().toBytes()
  await writeSecureFile(irohDir(), path, Buffer.from(secretKeyBytes).toString('hex'))
  return { secretKeyBytes, nodeId: nodeIdOf(secretKeyBytes) }
}
