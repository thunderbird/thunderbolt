/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract shared by backend (`backend/src/agents/routes.ts`) and frontend
 * (`src/dal/agents.ts`, `src/db/seeding/seed-agents.ts`) for the ACP feature.
 *
 * Both ends consume the same shape — drift here is silent breakage, so every
 * identifier the discovery response carries lives in one place.
 */

export type AgentType = 'built-in' | 'remote-acp' | 'managed-acp'

export type AgentTransport = 'in-process' | 'websocket'

/** Descriptor returned by `GET /agents` for remote (`remote-acp`) and
 *  server-managed (`managed-acp`) agents. The built-in agent is never on the
 *  wire — it is a hardcoded frontend constant in `src/defaults/agents.ts`. */
export type RemoteAgentDescriptor = {
  id: string
  name: string
  type: 'remote-acp' | 'managed-acp'
  transport: 'websocket'
  url: string
  description: string | null
  icon: string | null
  isSystem: 0 | 1
}

/** Envelope for `GET /agents`. `version` lets us evolve the shape later;
 *  `allowCustomAgents` mirrors backend `ALLOW_CUSTOM_AGENTS` env so the UI can
 *  hide the "+ Add Custom Agent" button per deployment. */
export type AgentDiscoveryResponse = {
  version: '1'
  agents: RemoteAgentDescriptor[]
  allowCustomAgents: boolean
}
