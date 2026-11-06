/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'
import type { Agent } from '@/types/acp'

export type AttestationTarget =
  | { kind: 'local'; key: string; provider: string; client: 'system' | 'user' }
  | { kind: 'agent'; key: string; name: string }
  | { kind: 'unsupported'; key: string }

/** Match the SDK cache's routing identity; BYOK never shares the managed proxy's evidence. */
export const tinfoilAttestationKey = (client: 'system' | 'user', cloudUrl: string): string =>
  client === 'user' ? 'tinfoil:user' : `tinfoil:system:${cloudUrl.replace(/\/$/, '')}`

/** Resolve the actual inference owner before considering a model's catalog flags. */
export const resolveAttestationTarget = (
  agent: Pick<Agent, 'id' | 'type' | 'name'>,
  model: Pick<Model, 'provider' | 'isSystem' | 'isConfidential'>,
  cloudUrl: string,
): AttestationTarget | null => {
  // ACP/hosted agents choose their own models. Their metadata is not local proof,
  // and a secure WebSocket/iroh connection does not attest the remote process.
  if (agent.type !== 'built-in') {
    return { kind: 'agent', key: `agent:${agent.id}`, name: agent.name }
  }
  if (model.provider === 'tinfoil') {
    const client = model.isSystem === 1 ? 'system' : 'user'
    return { kind: 'local', key: tinfoilAttestationKey(client, cloudUrl), provider: 'Tinfoil', client }
  }
  return model.isConfidential === 1 ? { kind: 'unsupported', key: `unsupported:${model.provider}` } : null
}
