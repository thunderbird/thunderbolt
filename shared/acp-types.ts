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

export type AgentType = 'built-in' | 'remote-acp' | 'managed-acp' | 'managed-http'

export type AgentTransport = 'in-process' | 'websocket' | 'http'

type AgentDescriptorBase = {
  id: string
  name: string
  url: string
  description: string | null
  icon: string | null
  isSystem: 0 | 1
  /** Set by the server on agents anonymous sessions may discover and use. */
  anonymousSafe?: boolean
}

/** Descriptor returned by `GET /agents` for remote (`remote-acp`),
 *  server-managed (`managed-acp`) and server-hosted (`managed-http`) agents.
 *  The built-in agent is never on the wire — it is a hardcoded frontend
 *  constant in `src/defaults/agents.ts`. `managed-http` agents carry a
 *  same-origin path (e.g. `/v1/agent/chat`) as `url` rather than `ws(s)://`. */
export type RemoteAgentDescriptor =
  | (AgentDescriptorBase & { type: 'remote-acp'; transport: 'websocket' })
  | (AgentDescriptorBase & { type: 'managed-acp'; transport: 'websocket' })
  | (AgentDescriptorBase & { type: 'managed-http'; transport: 'http' })

/** Envelope for `GET /agents`. `version` lets us evolve the shape later;
 *  `allowCustomAgents` mirrors backend `ALLOW_CUSTOM_AGENTS` env so the UI can
 *  hide the "+ Add Custom Agent" button per deployment. */
export type AgentDiscoveryResponse = {
  version: '1'
  agents: RemoteAgentDescriptor[]
  allowCustomAgents: boolean
}
