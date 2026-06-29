/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `thunderbolt iroh` admin actions: inspect this node's identity, hand out a
 * pairing ticket, and manage the peer allowlist.
 *
 *   id     print this node's NodeId and a fresh connection ticket
 *   pair   print a ticket as the out-of-band pairing primitive
 *   allow  add a peer NodeId to the allowlist (the authorization gate)
 */

import { EndpointId } from '@number0/iroh'
import type { IrohAdminAction } from '../agent/types.ts'
import { add } from './allowlist.ts'
import { bindServer } from './endpoint.ts'

/** Bind briefly to mint a current ticket (needs a live home relay), print it
 *  alongside the NodeId, then release the endpoint. The ticket is just an
 *  address, so the bind protocol is immaterial here. */
const printIdentity = async (headline: string): Promise<void> => {
  const { endpoint, nodeId, ticket } = await bindServer('acp')
  process.stdout.write(`${headline}\n  node id: ${nodeId}\n  ticket:  ${ticket}\n`)
  await endpoint.close()
}

/**
 * Run an `iroh` admin action.
 *
 * @param action - the parsed sub-action (`id` | `pair` | `allow`)
 */
export const runIrohAdmin = async (action: IrohAdminAction): Promise<void> => {
  if (action.kind === 'id') {
    await printIdentity('⚡ thunderbolt iroh identity')
    return
  }

  if (action.kind === 'pair') {
    await printIdentity('⚡ thunderbolt iroh pairing ticket — share this out-of-band')
    process.stdout.write(
      '  the peer connects with: thunderbolt acp connect <ticket>\n' +
        '  then allow them here:   thunderbolt iroh allow <their-node-id>\n' +
        '  (QR-code encoding of the ticket is deferred)\n',
    )
    return
  }

  // Validate the NodeId is a real ed25519 key before trusting it — parsing
  // throws on a malformed id, which surfaces as a clean CLI error.
  EndpointId.fromString(action.nodeId)
  const added = await add(action.nodeId)
  process.stdout.write(added ? `⚡ allowed ${action.nodeId}\n` : `⚡ ${action.nodeId} was already allowed\n`)
}
